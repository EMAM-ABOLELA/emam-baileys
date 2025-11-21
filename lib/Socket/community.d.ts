import { SocketConfig, GroupMetadata, GroupParticipant, ParticipantAction, WAMessageKey } from '../Types'
import { BinaryNode } from '../WABinary'
import { makeBusinessSocket } from './business'
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString, jidEncode, jidNormalizedUser } from '../WABinary'
import { generateMessageID, generateMessageIDV2, unixTimestampSeconds } from '../Utils'
import logger from '../Utils/logger'

export const makeCommunitiesSocket = (config: SocketConfig) => {
    const sock = makeBusinessSocket(config)
    const { authState, ev, query, upsertMessage } = sock

    const communityQuery = async (jid: string, type: 'get' | 'set', content: BinaryNode[]): Promise<BinaryNode> =>
        query({
            tag: 'iq',
            attrs: {
                type,
                xmlns: 'w:g2',
                to: jid
            },
            content
        })

    const communityMetadata = async (jid: string): Promise<GroupMetadata> => {
        const result = await communityQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
        return extractCommunityMetadata(result)
    }

    const communityFetchAllParticipating = async (): Promise<{ [_: string]: GroupMetadata }> => {
        const result = await query({
            tag: 'iq',
            attrs: {
                to: '@g.us',
                xmlns: 'w:g2',
                type: 'get'
            },
            content: [
                {
                    tag: 'participating',
                    attrs: {},
                    content: [
                        { tag: 'participants', attrs: {} },
                        { tag: 'description', attrs: {} }
                    ]
                }
            ]
        })
        const data: { [_: string]: GroupMetadata } = {}
        const communitiesChild = getBinaryNodeChild(result, 'communities')
        if (communitiesChild) {
            const communities = getBinaryNodeChildren(communitiesChild, 'community')
            for (const communityNode of communities) {
                const meta = extractCommunityMetadata({
                    tag: 'result',
                    attrs: {},
                    content: [communityNode]
                })
                data[meta.id] = meta
            }
        }

        sock.ev.emit('groups.update', Object.values(data))

        return data
    }

    async function parseGroupResult(node: BinaryNode): Promise<GroupMetadata | null> {
        logger.info({ node }, 'parseGroupResult')
        const groupNode = getBinaryNodeChild(node, 'group')
        if (groupNode) {
            try {
                logger.info({ groupNode }, 'groupNode')
                const metadata = await sock.groupMetadata(`${groupNode.attrs.id}@g.us`)
                return metadata ? metadata : null
            } catch (error) {
                console.error('Error parsing group metadata:', error)
                return null
            }
        }
        return null
    }

    sock.ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
        const { attrs } = getBinaryNodeChild(node, 'dirty')!
        if (attrs.type !== 'communities') {
            return
        }

        await communityFetchAllParticipating()
        await sock.cleanDirtyBits('groups')
    })

    const communityCreate = async (subject: string, body: string): Promise<GroupMetadata | null> => {
        const descriptionId = generateMessageID().substring(0, 12)

        const result = await communityQuery('@g.us', 'set', [
            {
                tag: 'create',
                attrs: { subject },
                content: [
                    {
                        tag: 'description',
                        attrs: { id: descriptionId },
                        content: [
                            {
                                tag: 'body',
                                attrs: {},
                                content: Buffer.from(body || '', 'utf-8')
                            }
                        ]
                    },
                    {
                        tag: 'parent',
                        attrs: { default_membership_approval_mode: 'request_required' }
                    },
                    {
                        tag: 'allow_non_admin_sub_group_creation',
                        attrs: {}
                    },
                    {
                        tag: 'create_general_chat',
                        attrs: {}
                    }
                ]
            }
        ])

        return await parseGroupResult(result)
    }

    const communityCreateGroup = async (subject: string, participants: string[], parentCommunityJid: string): Promise<GroupMetadata | null> => {
        const key = generateMessageIDV2()
        const result = await communityQuery('@g.us', 'set', [
            {
                tag: 'create',
                attrs: {
                    subject,
                    key
                },
                content: [
                    ...participants.map(jid => ({
                        tag: 'participant',
                        attrs: { jid }
                    })),
                    { tag: 'linked_parent', attrs: { jid: parentCommunityJid } }
                ]
            }
        ])
        return await parseGroupResult(result)
    }

    const communityLeave = async (id: string): Promise<void> => {
        await communityQuery('@g.us', 'set', [
            {
                tag: 'leave',
                attrs: {},
                content: [{ tag: 'community', attrs: { id } }]
            }
        ])
    }

    const communityUpdateSubject = async (jid: string, subject: string): Promise<void> => {
        await communityQuery(jid, 'set', [
            {
                tag: 'subject',
                attrs: {},
                content: Buffer.from(subject, 'utf-8')
            }
        ])
    }

    const communityLinkGroup = async (groupJid: string, parentCommunityJid: string): Promise<void> => {
        await communityQuery(parentCommunityJid, 'set', [
            {
                tag: 'links',
                attrs: {},
                content: [
                    {
                        tag: 'link',
                        attrs: { link_type: 'sub_group' },
                        content: [{ tag: 'group', attrs: { jid: groupJid } }]
                    }
                ]
            }
        ])
    }

    const communityUnlinkGroup = async (groupJid: string, parentCommunityJid: string): Promise<void> => {
        await communityQuery(parentCommunityJid, 'set', [
            {
                tag: 'unlink',
                attrs: { unlink_type: 'sub_group' },
                content: [{ tag: 'group', attrs: { jid: groupJid } }]
            }
        ])
    }

    const communityFetchLinkedGroups = async (jid: string): Promise<{
        communityJid: string
        isCommunity: boolean
        linkedGroups: Array<{
            id?: string
            subject: string
            creation?: number
            owner?: string
            size?: number
        }>
    }> => {
        let communityJid = jid
        let isCommunity = false

        const metadata = await sock.groupMetadata(jid)
        if (metadata.linkedParent) {
            communityJid = metadata.linkedParent
        } else {
            isCommunity = true
        }

        const result = await communityQuery(communityJid, 'get', [{ tag: 'sub_groups', attrs: {} }])

        const linkedGroupsData: Array<{
            id?: string
            subject: string
            creation?: number
            owner?: string
            size?: number
        }> = []
        const subGroupsNode = getBinaryNodeChild(result, 'sub_groups')
        if (subGroupsNode) {
            const groupNodes = getBinaryNodeChildren(subGroupsNode, 'group')
            for (const groupNode of groupNodes) {
                linkedGroupsData.push({
                    id: groupNode.attrs.id ? jidEncode(groupNode.attrs.id, 'g.us') : undefined,
                    subject: groupNode.attrs.subject || '',
                    creation: groupNode.attrs.creation ? Number(groupNode.attrs.creation) : undefined,
                    owner: groupNode.attrs.creator ? jidNormalizedUser(groupNode.attrs.creator) : undefined,
                    size: groupNode.attrs.size ? Number(groupNode.attrs.size) : undefined
                })
            }
        }

        return {
            communityJid,
            isCommunity,
            linkedGroups: linkedGroupsData
        }
    }

    const communityRequestParticipantsList = async (jid: string): Promise<Array<{ [key: string]: string }>> => {
        const result = await communityQuery(jid, 'get', [
            {
                tag: 'membership_approval_requests',
                attrs: {}
            }
        ])
        const node = getBinaryNodeChild(result, 'membership_approval_requests')
        const participants = getBinaryNodeChildren(node!, 'membership_approval_request')
        return participants.map(v => v.attrs)
    }

    const communityRequestParticipantsUpdate = async (jid: string, participants: string[], action: 'approve' | 'reject'): Promise<Array<{ status: string; jid: string }>> => {
        const result = await communityQuery(jid, 'set', [
            {
                tag: 'membership_requests_action',
                attrs: {},
                content: [
                    {
                        tag: action,
                        attrs: {},
                        content: participants.map(jid => ({
                            tag: 'participant',
                            attrs: { jid }
                        }))
                    }
                ]
            }
        ])
        const node = getBinaryNodeChild(result, 'membership_requests_action')
        const nodeAction = getBinaryNodeChild(node!, action)
        const participantsAffected = getBinaryNodeChildren(nodeAction!, 'participant')
        return participantsAffected.map(p => {
            return { status: p.attrs.error || '200', jid: p.attrs.jid }
        })
    }

    const communityParticipantsUpdate = async (jid: string, participants: string[], action: ParticipantAction): Promise<Array<{ status: string; jid: string; content: BinaryNode }>> => {
        const result = await communityQuery(jid, 'set', [
            {
                tag: action,
                attrs: action === 'remove' ? { linked_groups: 'true' } : {},
                content: participants.map(jid => ({
                    tag: 'participant',
                    attrs: { jid }
                }))
            }
        ])
        const node = getBinaryNodeChild(result, action)
        const participantsAffected = getBinaryNodeChildren(node!, 'participant')
        return participantsAffected.map(p => {
            return { status: p.attrs.error || '200', jid: p.attrs.jid, content: p }
        })
    }

    const communityUpdateDescription = async (jid: string, description?: string): Promise<void> => {
        const metadata = await communityMetadata(jid)
        const prev = metadata.descId ?? null

        await communityQuery(jid, 'set', [
            {
                tag: 'description',
                attrs: {
                    ...(description ? { id: generateMessageID() } : { delete: 'true' }),
                    ...(prev ? { prev } : {})
                },
                content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
            }
        ])
    }

    const communityInviteCode = async (jid: string): Promise<string | undefined> => {
        const result = await communityQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
        const inviteNode = getBinaryNodeChild(result, 'invite')
        return inviteNode?.attrs.code
    }

    const communityRevokeInvite = async (jid: string): Promise<string | undefined> => {
        const result = await communityQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
        const inviteNode = getBinaryNodeChild(result, 'invite')
        return inviteNode?.attrs.code
    }

    const communityAcceptInvite = async (code: string): Promise<string | undefined> => {
        const results = await communityQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
        const result = getBinaryNodeChild(results, 'community')
        return result?.attrs.jid
    }

    const communityRevokeInviteV4 = async (communityJid: string, invitedJid: string): Promise<boolean> => {
        const result = await communityQuery(communityJid, 'set', [
            { tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
        ])
        return !!result
    }

    const communityAcceptInviteV4 = ev.createBufferedFunction(
        async (key: string | WAMessageKey, inviteMessage: any): Promise<string> => {
            key = typeof key === 'string' ? { remoteJid: key } : key
            const results = await communityQuery(inviteMessage.groupJid, 'set', [
                {
                    tag: 'accept',
                    attrs: {
                        code: inviteMessage.inviteCode,
                        expiration: inviteMessage.inviteExpiration.toString(),
                        admin: key.remoteJid!
                    }
                }
            ])

            if (key.id) {
                inviteMessage.inviteExpiration = 0
                inviteMessage.inviteCode = ''
                ev.emit('messages.update', [
                    {
                        key,
                        update: {
                            message: {
                                groupInviteMessage: inviteMessage
                            }
                        }
                    }
                ])
            }

            await upsertMessage(
                {
                    key: {
                        remoteJid: inviteMessage.groupJid,
                        id: generateMessageIDV2(sock.user?.id),
                        fromMe: false,
                        participant: key.remoteJid
                    },
                    messageStubType: 21,
                    messageStubParameters: [JSON.stringify(authState.creds.me)],
                    participant: key.remoteJid,
                    messageTimestamp: unixTimestampSeconds()
                },
                'notify'
            )

            return results.attrs.from
        }
    )

    const communityGetInviteInfo = async (code: string): Promise<GroupMetadata> => {
        const results = await communityQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
        return extractCommunityMetadata(results)
    }

    const communityToggleEphemeral = async (jid: string, ephemeralExpiration: number): Promise<void> => {
        const content: BinaryNode = ephemeralExpiration
            ? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
            : { tag: 'not_ephemeral', attrs: {} }
        await communityQuery(jid, 'set', [content])
    }

    const communitySettingUpdate = async (jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'): Promise<void> => {
        await communityQuery(jid, 'set', [{ tag: setting, attrs: {} }])
    }

    const communityMemberAddMode = async (jid: string, mode: 'admin_add' | 'all_member_add'): Promise<void> => {
        await communityQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
    }

    const communityJoinApprovalMode = async (jid: string, mode: 'on' | 'off'): Promise<void> => {
        await communityQuery(jid, 'set', [
            { tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'community_join', attrs: { state: mode } }] }
        ])
    }

    return {
        ...sock,
        communityMetadata,
        communityCreate,
        communityCreateGroup,
        communityLeave,
        communityUpdateSubject,
        communityLinkGroup,
        communityUnlinkGroup,
        communityFetchLinkedGroups,
        communityRequestParticipantsList,
        communityRequestParticipantsUpdate,
        communityParticipantsUpdate,
        communityUpdateDescription,
        communityInviteCode,
        communityRevokeInvite,
        communityAcceptInvite,
        communityRevokeInviteV4,
        communityAcceptInviteV4,
        communityGetInviteInfo,
        communityToggleEphemeral,
        communitySettingUpdate,
        communityMemberAddMode,
        communityJoinApprovalMode,
        communityFetchAllParticipating
    }
}

export const extractCommunityMetadata = (result: BinaryNode): GroupMetadata => {
    const community = getBinaryNodeChild(result, 'community')!
    const descChild = getBinaryNodeChild(community, 'description')
    let desc: string | undefined
    let descId: string | undefined
    if (descChild) {
        desc = getBinaryNodeChildString(descChild, 'body')
        descId = descChild.attrs.id
    }

    const communityId = community.attrs.id?.includes('@')
        ? community.attrs.id
        : jidEncode(community.attrs.id || '', 'g.us')
    const eph = getBinaryNodeChild(community, 'ephemeral')?.attrs.expiration
    const memberAddMode = getBinaryNodeChildString(community, 'member_add_mode') === 'all_member_add'
    const metadata: GroupMetadata = {
        id: communityId,
        subject: community.attrs.subject || '',
        subjectOwner: community.attrs.s_o,
        subjectTime: Number(community.attrs.s_t || 0),
        size: getBinaryNodeChildren(community, 'participant').length,
        creation: Number(community.attrs.creation || 0),
        owner: community.attrs.creator ? jidNormalizedUser(community.attrs.creator) : undefined,
        desc,
        descId,
        linkedParent: getBinaryNodeChild(community, 'linked_parent')?.attrs.jid || undefined,
        restrict: !!getBinaryNodeChild(community, 'locked'),
        announce: !!getBinaryNodeChild(community, 'announcement'),
        isCommunity: !!getBinaryNodeChild(community, 'parent'),
        isCommunityAnnounce: !!getBinaryNodeChild(community, 'default_sub_community'),
        joinApprovalMode: !!getBinaryNodeChild(community, 'membership_approval_mode'),
        memberAddMode,
        participants: getBinaryNodeChildren(community, 'participant').map(({ attrs }) => {
            return {
                id: attrs.jid!,
                admin: (attrs.type || null) as GroupParticipant['admin']
            }
        }),
        ephemeralDuration: eph ? +eph : undefined,
        addressingMode: getBinaryNodeChildString(community, 'addressing_mode')! as GroupMetadata['addressingMode']
    }
    return metadata
}
