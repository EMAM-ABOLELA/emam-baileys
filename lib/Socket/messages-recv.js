"use strict"

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod }
}

Object.defineProperty(exports, "__esModule", { value: true })

const node_cache_1 = __importDefault(require("@cacheable/node-cache"))
const boom_1 = require("@hapi/boom")
const crypto_1 = require("crypto")
const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const Types_1 = require("../Types")
const Utils_1 = require("../Utils")
const make_mutex_1 = require("../Utils/make-mutex")
const WABinary_1 = require("../WABinary")
const groups_1 = require("./groups")
const messages_send_1 = require("./messages-send")

const makeMessagesRecvSocket = (config) => {
    const { logger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid, enableAutoSessionRecreation } = config
    const suki = messages_send_1.makeMessagesSocket(config)
    const { ev, authState, ws, processingMutex, signalRepository, query, upsertMessage, resyncAppState, onUnexpectedError, assertSessions, sendNode, relayMessage, sendReceipt, uploadPreKeys, getUSyncDevices, createParticipantNodes, sendPeerDataOperationMessage, messageRetryManager } = suki
    
    const retryMutex = make_mutex_1.makeMutex()
    
    const msgRetryCache = config.msgRetryCounterCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.MSG_RETRY,
        useClones: false
    })
    
    const callOfferCache = config.callOfferCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.CALL_OFFER,
        useClones: false
    })
    
    const placeholderResendCache = config.placeholderResendCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.MSG_RETRY,
        useClones: false
    })

    const identityAssertDebounce = new node_cache_1.default({ stdTTL: 5, useClones: false })
    
    let sendActiveReceipts = false

    const fetchMessageHistory = async (count, oldestMsgKey, oldestMsgTimestamp) => {
        if (!authState.creds.me?.id) {
            throw new boom_1.Boom('Not authenticated')
        }
        
        const pdoMessage = {
            historySyncOnDemandRequest: {
                chatJid: oldestMsgKey.remoteJid,
                oldestMsgFromMe: oldestMsgKey.fromMe,
                oldestMsgId: oldestMsgKey.id,
                oldestMsgTimestampMs: oldestMsgTimestamp,
                onDemandMsgCount: count
            },
            peerDataOperationRequestType: WAProto_1.proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
        }
        
        return sendPeerDataOperationMessage(pdoMessage)
    }
    
    const requestPlaceholderResend = async (messageKey) => {
        if (!authState.creds.me?.id) {
            throw new boom_1.Boom('Not authenticated')
        }
        
        if (placeholderResendCache.get(messageKey?.id)) {
            logger.debug({ messageKey }, 'already requested resend')
            return
        } else {
            placeholderResendCache.set(messageKey?.id, true)
        }
        
        await Utils_1.delay(5000)
        
        if (!placeholderResendCache.get(messageKey?.id)) {
            logger.debug({ messageKey }, 'message received while resend requested')
            return 'RESOLVED'
        }
        
        const pdoMessage = {
            placeholderMessageResendRequest: [{
                    messageKey
                }],
            peerDataOperationRequestType: WAProto_1.proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
        }
        
        setTimeout(() => {
            if (placeholderResendCache.get(messageKey?.id)) {
                logger.debug({ messageKey }, 'PDO message without response after 15 seconds. Phone possibly offline')
                placeholderResendCache.del(messageKey?.id)
            }
        }, 15000)
        
        return sendPeerDataOperationMessage(pdoMessage)
    }

    const handleMexNewsletterNotification = async (node) => {
        const mexNode = WABinary_1.getBinaryNodeChild(node, 'mex')
        if (!mexNode?.content) {
            logger.warn({ node }, 'Invalid mex newsletter notification')
            return
        }

        let data
        try {
            data = JSON.parse(mexNode.content.toString())
        } catch (error) {
            logger.error({ err: error, node }, 'Failed to parse mex newsletter notification')
            return
        }

        const operation = data?.operation
        const updates = data?.updates

        if (!updates || !operation) {
            logger.warn({ data }, 'Invalid mex newsletter notification content')
            return
        }

        logger.info({ operation, updates }, 'got mex newsletter notification')

        switch (operation) {
            case 'NotificationNewsletterUpdate':
                for (const update of updates) {
                    if (update.jid && update.settings && Object.keys(update.settings).length > 0) {
                        ev.emit('newsletter-settings.update', {
                            id: update.jid,
                            update: update.settings
                        })
                    }
                }
                break

            case 'NotificationNewsletterAdminPromote':
                for (const update of updates) {
                    if (update.jid && update.user) {
                        ev.emit('newsletter-participants.update', {
                            id: update.jid,
                            author: node.attrs.from,
                            user: update.user,
                            new_role: 'ADMIN',
                            action: 'promote'
                        })
                    }
                }
                break

            default:
                logger.info({ operation, data }, 'Unhandled mex newsletter notification')
                break
        }
    }

    const handleNewsletterNotification = async (node) => {
        const from = node.attrs.from
        const child = WABinary_1.getAllBinaryNodeChildren(node)[0]
        const author = node.attrs.participant

        logger.info({ from, child }, 'got newsletter notification')

        switch (child.tag) {
            case 'reaction':
                const reactionUpdate = {
                    id: from,
                    server_id: child.attrs.message_id,
                    reaction: {
                        code: WABinary_1.getBinaryNodeChildString(child, 'reaction'),
                        count: 1
                    }
                }
                ev.emit('newsletter.reaction', reactionUpdate)
                break

            case 'view':
                const viewUpdate = {
                    id: from,
                    server_id: child.attrs.message_id,
                    count: parseInt(child.content?.toString() || '0', 10)
                }
                ev.emit('newsletter.view', viewUpdate)
                break

            case 'participant':
                const participantUpdate = {
                    id: from,
                    author,
                    user: child.attrs.jid,
                    action: child.attrs.action,
                    new_role: child.attrs.role
                }
                ev.emit('newsletter-participants.update', participantUpdate)
                break

            case 'update':
                const settingsNode = WABinary_1.getBinaryNodeChild(child, 'settings')
                if (settingsNode) {
                    const update = {}
                    const nameNode = WABinary_1.getBinaryNodeChild(settingsNode, 'name')
                    if (nameNode?.content) update.name = nameNode.content.toString()

                    const descriptionNode = WABinary_1.getBinaryNodeChild(settingsNode, 'description')
                    if (descriptionNode?.content) update.description = descriptionNode.content.toString()

                    ev.emit('newsletter-settings.update', {
                        id: from,
                        update
                    })
                }
                break

            case 'message':
                const plaintextNode = WABinary_1.getBinaryNodeChild(child, 'plaintext')
                if (plaintextNode?.content) {
                    try {
                        const contentBuf = typeof plaintextNode.content === 'string'
                            ? Buffer.from(plaintextNode.content, 'binary')
                            : Buffer.from(plaintextNode.content)
                        const messageProto = WAProto_1.proto.Message.decode(contentBuf).toJSON()
                        const fullMessage = WAProto_1.proto.WebMessageInfo.fromObject({
                            key: {
                                remoteJid: from,
                                id: child.attrs.message_id || child.attrs.server_id,
                                fromMe: false
                            },
                            message: messageProto,
                            messageTimestamp: +child.attrs.t
                        }).toJSON()
                        await upsertMessage(fullMessage, 'append')
                        logger.info('Processed plaintext newsletter message')
                    } catch (error) {
                        logger.error({ error }, 'Failed to decode plaintext newsletter message')
                    }
                }
                break

            default:
                logger.warn({ node }, 'Unknown newsletter notification')
                break
        }
    }
    
    const sendMessageAck = async ({ tag, attrs, content }, errorCode) => {
        const stanza = {
            tag: 'ack',
            attrs: {
                id: attrs.id,
                to: attrs.from,
                class: tag
            }
        }
        
        if (!!errorCode) {
            stanza.attrs.error = errorCode.toString()
        }
        
        if (!!attrs.participant) {
            stanza.attrs.participant = attrs.participant
        }
        
        if (!!attrs.recipient) {
            stanza.attrs.recipient = attrs.recipient
        }
        
        if (!!attrs.type && (tag !== 'message' || WABinary_1.getBinaryNodeChild({ tag, attrs, content }, 'unavailable') || errorCode !== 0)) {
            stanza.attrs.type = attrs.type
        }
        
        if (tag === 'message' && WABinary_1.getBinaryNodeChild({ tag, attrs, content }, 'unavailable')) {
            stanza.attrs.from = authState.creds.me.id
        }
        
        logger.debug({ recv: { tag, attrs }, sent: stanza.attrs }, 'sent ack')
        await sendNode(stanza)
    }
    
    const offerCall = async (toJid, isVideo = false) => {
        const callId = crypto_1.randomBytes(16).toString('hex').toUpperCase().substring(0, 64)
        const offerContent = []
        offerContent.push({ tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined })
        offerContent.push({ tag: 'audio', attrs: { enc: 'opus', rate: '8000' }, content: undefined })
        
        if (isVideo) {
            offerContent.push({
                tag: 'video',
                attrs: { enc: 'vp8', dec: 'vp8', orientation: '0', 'screen_width': '1920', 'screen_height': '1080', 'device_orientation': '0' },
                content: undefined
            })
        }
        offerContent.push({ tag: 'net', attrs: { medium: '3' }, content: undefined })
        offerContent.push({ tag: 'capability', attrs: { ver: '1' }, content: new Uint8Array([1, 4, 255, 131, 207, 4]) })
        offerContent.push({ tag: 'encopt', attrs: { keygen: '2' }, content: undefined })
        
        const encKey = crypto_1.randomBytes(32)
        const devices = (await getUSyncDevices([toJid], true, false)).map(({ user, device }) => WABinary_1.jidEncode(user, 's.whatsapp.net', device))
        await assertSessions(devices, true)
        
        const { nodes: destinations, shouldIncludeDeviceIdentity } = await createParticipantNodes(devices, {
            call: {
                callKey: new Uint8Array(encKey)
            }
        }, { count: '0' })
        offerContent.push({ tag: 'destination', attrs: {}, content: destinations })
        
        if (shouldIncludeDeviceIdentity) {
            offerContent.push({
                tag: 'device-identity',
                attrs: {},
                content: Utils_1.encodeSignedDeviceIdentity(authState.creds.account, true)
            })
        }
        
        const stanza = ({
            tag: 'call',
            attrs: {
                id: Utils_1.generateMessageID(),
                to: toJid,
            },
            content: [{
                    tag: 'offer',
                    attrs: {
                        'call-id': callId,
                        'call-creator': authState.creds.me.id,
                    },
                    content: offerContent,
                }],
        })
        
        await query(stanza)
        
        return {
            id: callId,
            to: toJid
        }
    }
    
    const rejectCall = async (callId, callFrom) => {
        const stanza = ({
            tag: 'call',
            attrs: {
                from: authState.creds.me.id,
                to: callFrom,
            },
            content: [{
                    tag: 'reject',
                    attrs: {
                        'call-id': callId,
                        'call-creator': callFrom,
                        count: '0',
                    },
                    content: undefined,
                }],
        })
        
        await query(stanza)
    }
    
    const sendRetryRequest = async (node, forceIncludeKeys = false) => {
        const { fullMessage } = Utils_1.decodeMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '')
        const { key: msgKey } = fullMessage
        const msgId = msgKey.id

        if (messageRetryManager) {
            if (messageRetryManager.hasExceededMaxRetries(msgId)) {
                logger.debug({ msgId }, 'reached retry limit with new retry manager, clearing')
                messageRetryManager.markRetryFailed(msgId)
                return
            }

            const retryCount = messageRetryManager.incrementRetryCount(msgId)
            const key = `${msgId}:${msgKey?.participant}`
            await msgRetryCache.set(key, retryCount)
        } else {
            const key = `${msgId}:${msgKey?.participant}`
            let retryCount = msgRetryCache.get(key) || 0
            if (retryCount >= maxMsgRetryCount) {
                logger.debug({ retryCount, msgId }, 'reached retry limit, clearing')
                msgRetryCache.del(key)
                return
            }

            retryCount += 1
            msgRetryCache.set(key, retryCount)
        }

        const key = `${msgId}:${msgKey?.participant}`
        const retryCount = msgRetryCache.get(key) || 1

        const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds
        const fromJid = node.attrs.from

        let shouldRecreateSession = false
        let recreateReason = ''

        if (enableAutoSessionRecreation && messageRetryManager) {
            try {
                const sessionId = signalRepository.jidToSignalProtocolAddress(fromJid)
                const hasSession = await signalRepository.validateSession(fromJid)
                const result = messageRetryManager.shouldRecreateSession(fromJid, retryCount, hasSession.exists)
                shouldRecreateSession = result.recreate
                recreateReason = result.reason

                if (shouldRecreateSession) {
                    logger.debug({ fromJid, retryCount, reason: recreateReason }, 'recreating session for retry')
                    await authState.keys.set({ session: { [sessionId]: null } })
                    forceIncludeKeys = true
                }
            } catch (error) {
                logger.warn({ error, fromJid }, 'failed to check session recreation')
            }
        }

        if (retryCount <= 2) {
            if (messageRetryManager) {
                messageRetryManager.schedulePhoneRequest(msgId, async () => {
                    try {
                        const requestId = await requestPlaceholderResend(msgKey)
                        logger.debug(`sendRetryRequest: requested placeholder resend (${requestId}) for message ${msgId} (scheduled)`)
                    } catch (error) {
                        logger.warn({ error, msgId }, 'failed to send scheduled phone request')
                    }
                })
            } else {
                const msgId = await requestPlaceholderResend(msgKey)
                logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`)
            }
        }

        const deviceIdentity = Utils_1.encodeSignedDeviceIdentity(account, true)
        
        await authState.keys.transaction(async () => {
            const receipt = {
                tag: 'receipt',
                attrs: {
                    id: msgId,
                    type: 'retry',
                    to: node.attrs.from
                },
                content: [
                    {
                        tag: 'retry',
                        attrs: {
                            count: retryCount.toString(),
                            id: node.attrs.id,
                            t: node.attrs.t,
                            v: '1',
                            error: '0'
                        }
                    },
                    {
                        tag: 'registration',
                        attrs: {},
                        content: Utils_1.encodeBigEndian(authState.creds.registrationId)
                    }
                ]
            }
            
            if (node.attrs.recipient) {
                receipt.attrs.recipient = node.attrs.recipient
            }
            
            if (node.attrs.participant) {
                receipt.attrs.participant = node.attrs.participant
            }
            
            if (retryCount > 1 || forceIncludeKeys || shouldRecreateSession) {
                const { update, preKeys } = await Utils_1.getNextPreKeys(authState, 1)
                const [keyId] = Object.keys(preKeys)
                const key = preKeys[+keyId]
                const content = receipt.content
                
                content.push({
                    tag: 'keys',
                    attrs: {},
                    content: [
                        { tag: 'type', attrs: {}, content: Buffer.from(Defaults_1.KEY_BUNDLE_TYPE) },
                        { tag: 'identity', attrs: {}, content: identityKey.public },
                        Utils_1.xmppPreKey(key, +keyId),
                        Utils_1.xmppSignedPreKey(signedPreKey),
                        { tag: 'device-identity', attrs: {}, content: deviceIdentity }
                    ]
                })
                ev.emit('creds.update', update)
            }
            
            await sendNode(receipt)
            
            logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt')
        })
    }
    
    const handleEncryptNotification = async (node) => {
        const from = node.attrs.from
        if (from === WABinary_1.S_WHATSAPP_NET) {
            const countChild = WABinary_1.getBinaryNodeChild(node, 'count')
            const count = +countChild.attrs.value
            const shouldUploadMorePreKeys = count < Defaults_1.MIN_PREKEY_COUNT
            logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count')
            
            if (shouldUploadMorePreKeys) {
                await uploadPreKeys()
            }
        }
        
        else {
            const identityNode = WABinary_1.getBinaryNodeChild(node, 'identity')
            if (identityNode) {
                logger.info({ jid: from }, 'identity changed')
                if (identityAssertDebounce.get(from)) {
                    logger.debug({ jid: from }, 'skipping identity assert (debounced)')
                    return
                }

                identityAssertDebounce.set(from, true)
                try {
                    await assertSessions([from], true)
                } catch (error) {
                    logger.warn({ error, jid: from }, 'failed to assert sessions after identity change')
                }
            }
            
            else {
                logger.info({ node }, 'unknown encrypt notification')
            }
        }
    }
    
    const handleGroupNotification = (fullNode, child, msg) => {
        const actingParticipantLid = fullNode.attrs.participant
        const actingParticipantPn = fullNode.attrs.participant_pn

        const affectedParticipantLid = WABinary_1.getBinaryNodeChild(child, 'participant')?.attrs?.jid || actingParticipantLid
        const affectedParticipantPn = WABinary_1.getBinaryNodeChild(child, 'participant')?.attrs?.phone_number || actingParticipantPn

        switch (child.tag) {
            case 'create':
                const metadata = groups_1.extractGroupMetadata(child)
                msg.messageStubType = Types_1.WAMessageStubType.GROUP_CREATE
                msg.messageStubParameters = [metadata.subject]
                msg.key = { participant: metadata.owner, participantAlt: metadata.ownerPn }
                ev.emit('chats.upsert', [{
                        id: metadata.id,
                        name: metadata.subject,
                        conversationTimestamp: metadata.creation,
                    }])
                ev.emit('groups.upsert', [{
                        ...metadata,
                        author: actingParticipantLid,
                        authorPn: actingParticipantPn
                    }])
                break
            case 'delete':
                msg.messageStubType = Types_1.WAMessageStubType.COMMUNITY_PARENT_GROUP_DELETED
                msg.messageStubParameters = [affectedParticipantLid, 'delete']
                break
            case 'ephemeral':
            case 'not_ephemeral':
                msg.message = {
                    protocolMessage: {
                        type: WAProto_1.proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                        ephemeralExpiration: +(child.attrs.expiration || 0)
                    }
                }
                break
            case 'modify':
                const oldNumber = WABinary_1.getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid)
                msg.messageStubParameters = oldNumber || []
                msg.messageStubType = Types_1.WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER
                break
            case 'promote':
            case 'demote':
            case 'remove':
            case 'add':
            case 'leave':
                let stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`
                if (child.attrs?.reason === 'linked_group_join') {
                	stubType = 'GROUP_PARTICIPANT_LINKED_GROUP_JOIN'
                }
                msg.messageStubType = Types_1.WAMessageStubType[stubType]
                const participants = WABinary_1.getBinaryNodeChildren(child, 'participant').map(({ attrs }) => {
                    return {
                        id: attrs.jid,
                        phoneNumber: WABinary_1.isLidUser(attrs.jid) && WABinary_1.isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
                        lid: WABinary_1.isPnUser(attrs.jid) && WABinary_1.isLidUser(attrs.lid) ? attrs.lid : undefined,
                        admin: (attrs.type || null)
                    }
                })

                if (participants.length === 1 &&
                    (WABinary_1.areJidsSameUser(participants[0].id, actingParticipantLid) ||
                     WABinary_1.areJidsSameUser(participants[0].id, actingParticipantPn)) &&
                    child.tag === 'remove') {
                    msg.messageStubType = Types_1.WAMessageStubType.GROUP_PARTICIPANT_LEAVE
                }

                msg.messageStubParameters = participants.map(a => JSON.stringify(a))
                break
            case 'subject':
                msg.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_SUBJECT
                msg.messageStubParameters = [child.attrs.subject]
                break
            case 'description':
                const description = WABinary_1.getBinaryNodeChild(child, 'body')?.content?.toString()
                msg.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_DESCRIPTION
                msg.messageStubParameters = description ? [description] : undefined
                break
            case 'announcement':
            case 'not_announcement':
                msg.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_ANNOUNCE
                msg.messageStubParameters = [(child.tag === 'announcement') ? 'on' : 'off']
                break
            case 'locked':
            case 'unlocked':
                msg.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_RESTRICT
                msg.messageStubParameters = [(child.tag === 'locked') ? 'on' : 'off']
                break
            case 'invite':
                msg.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_INVITE_LINK
                msg.messageStubParameters = [child.attrs.code]
                break
            case 'member_add_mode':
                const addMode = child.content
                if (addMode) {
                    msg.messageStubType = Types_1.WAMessageStubType.GROUP_MEMBER_ADD_MODE
                    msg.messageStubParameters = [addMode.toString()]
                }
                break
            case 'membership_approval_mode':
                const approvalMode = WABinary_1.getBinaryNodeChild(child, 'group_join')
                if (approvalMode) {
                    msg.messageStubType = Types_1.WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE
                    msg.messageStubParameters = [approvalMode.attrs.state]
                }
                break
            case 'created_membership_requests':
                msg.messageStubType = Types_1.WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
                msg.messageStubParameters = [
                    JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
                    'created',
                    child.attrs.request_method
                ]
                break
            case 'revoked_membership_requests':
                const isDenied = WABinary_1.areJidsSameUser(affectedParticipantLid, actingParticipantLid)
                msg.messageStubType = Types_1.WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
                msg.messageStubParameters = [
                    JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
                    isDenied ? 'revoked' : 'rejected'
                ]
                break
            case 'link':
            case 'unlink':
                const type = child.attrs?.unlink_type || child.attrs?.link_type
                const stubMap = {
                	parent_group: Types_1.WAMessageStubType[`COMMUNITY_${child.tag.toUpperCase()}_PARENT_GROUP`],
                    sibling_group: Types_1.WAMessageStubType[`COMMUNITY_${child.tag.toUpperCase()}_SIBLING_GROUP`],
                    sub_group: Types_1.WAMessageStubType[`COMMUNITY_${child.tag.toUpperCase()}_SUB_GROUP`]
                }
                const groups = WABinary_1.getBinaryNodeChildren(child, 'group')
                    .map(g => g.attrs?.jid || g.attrs?.subject || '')
                    .filter(x => x)
                msg.messageStubType = stubMap?.[type] || Types_1.WAMessageStubType[`COMMUNITY_${child.tag.toUpperCase()}_PARENT_GROUP`]
                msg.messageStubParameters = [affectedParticipantLid, child.tag, groups]
                break
            case 'linked_group_promote':
            case 'linked_group_demote':
                const stubtype = `COMMUNITY_PARTICIPANT_${child.tag.split('_')[2].toUpperCase()}`
                const participantS = WABinary_1.getBinaryNodeChildren(child, 'participant').map(({ attrs }) => {
                    return {
                        id: attrs.jid,
                        phoneNumber: WABinary_1.isLidUser(attrs.jid) && WABinary_1.isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
                        lid: WABinary_1.isPnUser(attrs.jid) && WABinary_1.isLidUser(attrs.lid) ? attrs.lid : undefined
                    }
                })
                msg.messageStubType = Types_1.WAMessageStubType[stubtype]
                msg.messageStubParameters = participantS.map(a => JSON.stringify(a))
                break
            case 'created_sub_group_suggestion':    
                msg.messageStubType = Types_1.WAMessageStubType.SUGGESTED_SUBGROUP_ANNOUNCE
                msg.messageStubParameters = [JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }), 'add']
                break
            case 'revoked_sub_group_suggestions':
                const res = WABinary_1.getBinaryNodeChildren(child, 'sub_group_suggestions')
                const reason = res.attrs?.reason 
                if (reason === 'approved') msg.messageStubType = Types_1.WAMessageStubType.GROUP_CREATE
                else msg.messageStubType = Types_1.WAMessageStubType.GENERIC_NOTIFICATION
                msg.messageStubParameters = [JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }), reason]
                break
            default:
                logger.warn(child.tag, 'Unhandled group node') 
                break
        }
    }

    const processNotification = async (node) => {
        const result = {}
        const [child] = WABinary_1.getAllBinaryNodeChildren(node)
        const nodeType = node.attrs.type
        const from = WABinary_1.jidNormalizedUser(node.attrs.from)
        
        switch (nodeType) {
            case 'privacy_token':
                await handlePrivacyTokenNotification(node)
                break
            case 'w:gp2':
                handleGroupNotification(node, child, result)
                break
            case 'newsletter':
                await handleNewsletterNotification(node)
                break
            case 'mex':
                await handleMexNewsletterNotification(node)
                break
            case 'mediaretry':
                const event = Utils_1.decodeMediaRetryNode(node)
                ev.emit('messages.media-update', [event])
                break
            case 'encrypt':
                await handleEncryptNotification(node)
                break
            case 'devices':
                const devices = WABinary_1.getBinaryNodeChildren(child, 'device')
                if (WABinary_1.areJidsSameUser(child.attrs.jid, authState.creds.me.id) || WABinary_1.areJidsSameUser(child.attrs.lid, authState.creds.me.lid)) {
                    const deviceData = devices.map(d => ({ id: d.attrs.jid, lid: d.attrs.lid }))
                    logger.info({ deviceData }, 'my own devices changed')
                }
                break
            case 'server_sync':
                const update = WABinary_1.getBinaryNodeChild(node, 'collection')
                if (update) {
                    const name = update.attrs.name
                    await resyncAppState([name], false)
                }
                break
            case 'picture':
                const setPicture = WABinary_1.getBinaryNodeChild(node, 'set')
                const delPicture = WABinary_1.getBinaryNodeChild(node, 'delete')
                ev.emit('contacts.update', [{
                        id: WABinary_1.jidNormalizedUser(node?.attrs?.from) || (setPicture || delPicture)?.attrs?.hash || '',
                        imgUrl: setPicture ? 'changed' : 'removed'
                    }])
                if (WABinary_1.isJidGroup(from)) {
                    const node = setPicture || delPicture
                    result.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_ICON
                    if (setPicture) {
                        result.messageStubParameters = [setPicture.attrs.id]
                    }
                    result.participant = node?.attrs?.author
                    result.key = {
                        ...result.key || {},
                        participant: setPicture?.attrs?.author
                    }
                }
                break
            case 'account_sync':
                if (child.tag === 'disappearing_mode') {
                    const newDuration = +child.attrs.duration
                    const timestamp = +child.attrs.t
                    logger.info({ newDuration }, 'updated account disappearing mode')
                    ev.emit('creds.update', {
                        accountSettings: {
                            ...authState.creds.accountSettings,
                            defaultDisappearingMode: {
                                ephemeralExpiration: newDuration,
                                ephemeralSettingTimestamp: timestamp,
                            },
                        }
                    })
                }
                else if (child.tag === 'blocklist') {
                    const blocklists = WABinary_1.getBinaryNodeChildren(child, 'item')
                    for (const { attrs } of blocklists) {
                        const blocklist = [attrs.jid]
                        const type = (attrs.action === 'block') ? 'add' : 'remove'
                        ev.emit('blocklist.update', { blocklist, type })
                    }
                }
                break
            case 'link_code_companion_reg':
                const linkCodeCompanionReg = WABinary_1.getBinaryNodeChild(node, 'link_code_companion_reg')
                const ref = toRequiredBuffer(WABinary_1.getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'))
                const primaryIdentityPublicKey = toRequiredBuffer(WABinary_1.getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub'))
                const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(WABinary_1.getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub'))
                const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped)
                const companionSharedKey = Utils_1.Curve.sharedKey(authState.creds.pairingEphemeralKeyPair.private, codePairingPublicKey)
                const random = crypto_1.randomBytes(32)
                const linkCodeSalt = crypto_1.randomBytes(32)
                
                const linkCodePairingExpanded = await Utils_1.hkdf(companionSharedKey, 32, {
                    salt: linkCodeSalt,
                    info: 'link_code_pairing_key_bundle_encryption_key'
                })
                
                const encryptPayload = Buffer.concat([Buffer.from(authState.creds.signedIdentityKey.public), primaryIdentityPublicKey, random])
                const encryptIv = crypto_1.randomBytes(12)
                const encrypted = Utils_1.aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0))
                const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted])
                const identitySharedKey = Utils_1.Curve.sharedKey(authState.creds.signedIdentityKey.private, primaryIdentityPublicKey)
                const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random])
                
                authState.creds.advSecretKey = (await Utils_1.hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64')
                
                await query({
                    tag: 'iq',
                    attrs: {
                        to: WABinary_1.S_WHATSAPP_NET,
                        type: 'set',
                        id: suki.generateMessageTag(),
                        xmlns: 'md'
                    },
                    content: [
                        {
                            tag: 'link_code_companion_reg',
                            attrs: {
                                jid: authState.creds.me.id,
                                stage: 'companion_finish',
                            },
                            content: [
                                {
                                    tag: 'link_code_pairing_wrapped_key_bundle',
                                    attrs: {},
                                    content: encryptedPayload
                                },
                                {
                                    tag: 'companion_identity_public',
                                    attrs: {},
                                    content: authState.creds.signedIdentityKey.public
                                },
                                {
                                    tag: 'link_code_pairing_ref',
                                    attrs: {},
                                    content: ref
                                }
                            ]
                        }
                    ]
                })
                
                authState.creds.registered = true
                ev.emit('creds.update', authState.creds)
        }
        
        if (Object.keys(result).length) {
            return result
        }
    }

    const handlePrivacyTokenNotification = async (node) => {
        const tokensNode = WABinary_1.getBinaryNodeChild(node, 'tokens')
        const from = WABinary_1.jidNormalizedUser(node.attrs.from)

        if (!tokensNode) return

        const tokenNodes = WABinary_1.getBinaryNodeChildren(tokensNode, 'token')

        for (const tokenNode of tokenNodes) {
            const { attrs, content } = tokenNode
            const type = attrs.type
            const timestamp = attrs.t

            if (type === 'trusted_contact' && content instanceof Buffer) {
                logger.debug(
                    {
                        from,
                        timestamp,
                        tcToken: content
                    },
                    'received trusted contact token'
                )

                await authState.keys.set({
                    tctoken: { [from]: { token: content, timestamp } }
                })
            }
        }
    }
    
    async function decipherLinkPublicKey(data) {
        const buffer = toRequiredBuffer(data)
        const salt = buffer.slice(0, 32)
        const secretKey = await Utils_1.derivePairingCodeKey(authState.creds.pairingCode, salt)
        const iv = buffer.slice(32, 48)
        const payload = buffer.slice(48, 80)
        return Utils_1.aesDecryptCTR(payload, secretKey, iv)
    }
    
    function toRequiredBuffer(data) {
        if (data === undefined) {
            throw new boom_1.Boom('Invalid buffer', { statusCode: 400 })
        }
        return data instanceof Buffer ? data : Buffer.from(data)
    }
    
    const willSendMessageAgain = (id, participant) => {
        const key = `${id}:${participant}`
        const retryCount = msgRetryCache.get(key) || 0
        return retryCount < maxMsgRetryCount
    }
    
    const updateSendMessageAgainCount = (id, participant) => {
        const key = `${id}:${participant}`
        const newValue = (msgRetryCache.get(key) || 0) + 1
        msgRetryCache.set(key, newValue)
    }
    
    const sendMessagesAgain = async (key, ids, retryNode) => {
        const remoteJid = key.remoteJid
        const participant = key.participant || remoteJid

        const retryCount = +retryNode.attrs.count || 1

        const msgs = []
        for (const id of ids) {
            let msg

            if (messageRetryManager) {
                const cachedMsg = messageRetryManager.getRecentMessage(remoteJid, id)
                if (cachedMsg) {
                    msg = cachedMsg.message
                    logger.debug({ jid: remoteJid, id }, 'found message in retry cache')
                    messageRetryManager.markRetrySuccess(id)
                }
            }

            if (!msg) {
                msg = await getMessage({ ...key, id })
                if (msg) {
                    logger.debug({ jid: remoteJid, id }, 'found message via getMessage')
                    if (messageRetryManager) {
                        messageRetryManager.markRetrySuccess(id)
                    }
                }
            }

            msgs.push(msg)
        }

        const sendToAll = !WABinary_1.jidDecode(participant)?.device

        let shouldRecreateSession = false
        let recreateReason = ''

        if (enableAutoSessionRecreation && messageRetryManager) {
            try {
                const sessionId = signalRepository.jidToSignalProtocolAddress(participant)
                const hasSession = await signalRepository.validateSession(participant)
                const result = messageRetryManager.shouldRecreateSession(participant, retryCount, hasSession.exists)
                shouldRecreateSession = result.recreate
                recreateReason = result.reason

                if (shouldRecreateSession) {
                    logger.debug({ participant, retryCount, reason: recreateReason }, 'recreating session for outgoing retry')
                    await authState.keys.set({ session: { [sessionId]: null } })
                }
            } catch (error) {
                logger.warn({ error, participant }, 'failed to check session recreation for outgoing retry')
            }
        }

        await assertSessions([participant], true)

        if (WABinary_1.isJidGroup(remoteJid)) {
            await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } })
        }

        logger.debug({ participant, sendToAll, shouldRecreateSession, recreateReason }, 'forced new session for retry recp')

        for (const [i, msg] of msgs.entries()) {
            if (!ids[i]) continue

            if (msg && willSendMessageAgain(ids[i], participant)) {
                updateSendMessageAgainCount(ids[i], participant)
                const msgRelayOpts = { messageId: ids[i] }

                if (sendToAll) {
                    msgRelayOpts.useUserDevicesCache = false
                } else {
                    msgRelayOpts.participant = {
                        jid: participant,
                        count: +retryNode.attrs.count
                    }
                }

                await relayMessage(key.remoteJid, msg, msgRelayOpts)
            } else {
                logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available')
            }
        }
    }
    
    const handleReceipt = async (node) => {
        const { attrs, content } = node
        const isLid = attrs.from.includes('lid')
        const isNodeFromMe = WABinary_1.areJidsSameUser(attrs.participant || attrs.from, isLid ? authState.creds.me?.lid : authState.creds.me?.id)
        const remoteJid = !isNodeFromMe || WABinary_1.isJidGroup(attrs.from) ? attrs.from : attrs.recipient
        const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe)
        
        const key = {
            remoteJid,
            id: '',
            fromMe,
            participant: attrs.participant
        }
        
        if (shouldIgnoreJid(remoteJid) && remoteJid !== WABinary_1.S_WHATSAPP_NET) {
            logger.debug({ remoteJid }, 'ignoring receipt from jid')
            await sendMessageAck(node)
            return
        }
        
        const ids = [attrs.id]
        if (Array.isArray(content)) {
            const items = WABinary_1.getBinaryNodeChildren(content[0], 'item')
            ids.push(...items.map(i => i.attrs.id))
        }
        
        try {
            await Promise.all([
                processingMutex.mutex(async () => {
                    const status = Utils_1.getStatusFromReceiptType(attrs.type)
                    
                    if (typeof status !== 'undefined' && (
                        status >= WAProto_1.proto.WebMessageInfo.Status.SERVER_ACK ||
                            !isNodeFromMe)) {
                        if (WABinary_1.isJidGroup(remoteJid) || WABinary_1.isJidStatusBroadcast(remoteJid)) {
                            if (attrs.participant) {
                                const updateKey = status === WAProto_1.proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp'
                                ev.emit('message-receipt.update', ids.map(id => ({
                                    key: { ...key, id },
                                    receipt: {
                                        userJid: WABinary_1.jidNormalizedUser(attrs.participant),
                                        [updateKey]: +attrs.t
                                    }
                                })))
                            }
                        }
                        
                        else {
                            ev.emit('messages.update', ids.map(id => ({
                                key: { ...key, id },
                                update: { status }
                            })))
                        }
                    }
                    
                    if (attrs.type === 'retry') {
                        key.participant = key.participant || attrs.from
                        const retryNode = WABinary_1.getBinaryNodeChild(node, 'retry')
                        
                        if (ids[0] && key.participant && willSendMessageAgain(ids[0], key.participant)) {
                            if (key.fromMe) {
                                try {
                                    updateSendMessageAgainCount(ids[0], key.participant)
                                    logger.debug({ attrs, key }, 'recv retry request')
                                    await sendMessagesAgain(key, ids, retryNode)
                                }
                                
                                catch (error) {
                                    logger.error({ key, ids, trace: error.stack }, 'error in sending message again')
                                }
                            }
                            
                            else {
                                logger.info({ attrs, key }, 'recv retry for not fromMe message')
                            }
                        }
                        
                        else {
                            logger.info({ attrs, key }, 'will not send message again, as sent too many times')
                        }
                    }
                })
            ])
        }
        finally {
            await sendMessageAck(node)
        }
    }
    
    const handleNotification = async (node) => {
        const remoteJid = node.attrs.from
        
        if (shouldIgnoreJid(remoteJid) && remoteJid !== WABinary_1.S_WHATSAPP_NET) {
            logger.debug({ remoteJid, id: node.attrs.id }, 'ignored notification')
            await sendMessageAck(node)
            return
        }
        
        try {
            await Promise.all([
                processingMutex.mutex(async () => {
                    const msg = await processNotification(node)
                    
                    if (msg) {
                        const fromMe = WABinary_1.areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me.id)
                        const { senderAlt: participantAlt, addressingMode } = Utils_1.extractAddressingContext(node)
                        msg.key = {
                            remoteJid,
                            fromMe,
                            participant: node.attrs.participant,
                            participantAlt,
                            addressingMode,
                            id: node.attrs.id,
                            ...(msg.key || {})
                        }
                        msg.participant = msg.participant ? msg.participant : node.attrs.participant
                        msg.messageTimestamp = +node.attrs.t
                        const fullMsg = WAProto_1.proto.WebMessageInfo.fromObject(msg)
                        await upsertMessage(fullMsg, 'append')
                    }
                })
            ])
        }
        finally {
            await sendMessageAck(node)
        }
    }
    
    const handleMessage = async (node) => {
        if (shouldIgnoreJid(node.attrs.from) && node.attrs.from !== WABinary_1.S_WHATSAPP_NET) {
            logger.debug({ key: node.attrs.key }, 'ignored message')
            await sendMessageAck(node, Utils_1.NACK_REASONS.UnhandledError)
            return
        }

        const encNode = WABinary_1.getBinaryNodeChild(node, 'enc')
        if (encNode && encNode.attrs.type === 'msmsg') {
            logger.debug({ key: node.attrs.key }, 'ignored msmsg')
            await sendMessageAck(node, Utils_1.NACK_REASONS.MissingMessageSecret)
            return
        }
        
        const { fullMessage: msg, category, author, decrypt } = Utils_1.decryptMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '', signalRepository, logger)

        const alt = msg.key.participantAlt || msg.key.remoteJidAlt
        if (!!alt) {
            const altServer = WABinary_1.jidDecode(alt)?.server
            const primaryJid = msg.key.participant || msg.key.remoteJid
            if (altServer === 'lid') {
                if (!(await signalRepository.lidMapping.getPNForLID(alt))) {
                    await signalRepository.lidMapping.storeLIDPNMappings([{ lid: alt, pn: primaryJid }])
                    await signalRepository.migrateSession(primaryJid, alt)
                }
            } else {
                await signalRepository.lidMapping.storeLIDPNMappings([{ lid: primaryJid, pn: alt }])
                await signalRepository.migrateSession(alt, primaryJid)
            }
        }

        if (msg.key?.remoteJid && msg.key?.id && messageRetryManager) {
            messageRetryManager.addRecentMessage(msg.key.remoteJid, msg.key.id, msg.message)
            logger.debug(
                {
                    jid: msg.key.remoteJid,
                    id: msg.key.id
                },
                'Added message to recent cache for retry receipts'
            )
        }
        
        try {
            await processingMutex.mutex(async () => {
                await decrypt()
                if (msg.messageStubType === WAProto_1.proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
                    if (
                        msg?.messageStubParameters?.[0] === Utils_1.MISSING_KEYS_ERROR_TEXT ||
                        msg.messageStubParameters?.[0] === Utils_1.NO_MESSAGE_FOUND_ERROR_TEXT
                    ) {
                        return sendMessageAck(node)
                    }

                    const errorMessage = msg?.messageStubParameters?.[0] || ''
                    const isPreKeyError = errorMessage.includes('PreKey')

                    logger.debug(`[handleMessage] Attempting retry request for failed decryption`)

                    await retryMutex.mutex(async () => {
                        try {
                            if (!ws.isOpen) {
                                logger.debug({ node }, 'Connection closed, skipping retry')
                                return
                            }

                            if (isPreKeyError) {
                                logger.info({ error: errorMessage }, 'PreKey error detected, uploading and retrying')

                                try {
                                    logger.debug('Uploading pre-keys for error recovery')
                                    await uploadPreKeys(5)
                                    logger.debug('Waiting for server to process new pre-keys')
                                    await Utils_1.delay(1000)
                                } catch (uploadErr) {
                                    logger.error({ uploadErr }, 'Pre-key upload failed, proceeding with retry anyway')
                                }
                            }

                            const encNode = WABinary_1.getBinaryNodeChild(node, 'enc')
                            await sendRetryRequest(node, !encNode)
                            if (retryRequestDelayMs) {
                                await Utils_1.delay(retryRequestDelayMs)
                            }
                        } catch (err) {
                            logger.error({ err, isPreKeyError }, 'Failed to handle retry, attempting basic retry')
                            try {
                                const encNode = WABinary_1.getBinaryNodeChild(node, 'enc')
                                await sendRetryRequest(node, !encNode)
                            } catch (retryErr) {
                                logger.error({ retryErr }, 'Failed to send retry after error handling')
                            }
                        }

                        await sendMessageAck(node, Utils_1.NACK_REASONS.UnhandledError)
                    })
                } else {
                    const isNewsletter = WABinary_1.isJidNewsletter(msg.key.remoteJid)
                    if (!isNewsletter) {
                        let type = undefined
                        let participant = msg.key.participant
                        if (category === 'peer') {
                            type = 'peer_msg'
                        } else if (msg.key.fromMe) {
                            type = 'sender'
                            if (WABinary_1.isLidUser(msg.key.remoteJid) || WABinary_1.isLidUser(msg.key.remoteJidAlt)) {
                                participant = author
                            }
                        } else if (!sendActiveReceipts) {
                            type = 'inactive'
                        }

                        await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type)

                        const isAnyHistoryMsg = Utils_1.getHistoryMsg(msg.message)
                        if (isAnyHistoryMsg) {
                            const jid = WABinary_1.jidNormalizedUser(msg.key.remoteJid)
                            await sendReceipt(jid, undefined, [msg.key.id], 'hist_sync')
                        }
                    } else {
                        await sendMessageAck(node)
                        logger.debug({ key: msg.key }, 'processed newsletter message without receipts')
                    }
                }
                
                Utils_1.cleanMessage(msg, authState.creds.me.id, authState.creds.me.lid)
                await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')
            })
        }
        
        catch (error) {
            logger.error({ error, node: WABinary_1.binaryNodeToString(node) }, 'error in handling message')
        }
    }
    
    const handleCall = async (node) => {
        const { attrs } = node
        const [infoChild] = WABinary_1.getAllBinaryNodeChildren(node)
        const status = Utils_1.getCallStatusFromNode(infoChild)
        
        const callId = infoChild.attrs['call-id']
        const from = infoChild.attrs.from || infoChild.attrs['call-creator']
        
        const call = {
            chatId: attrs.from,
            from,
            id: callId,
            date: new Date(+attrs.t * 1000),
            offline: !!attrs.offline,
            status,
        }
        
        if (status === 'offer') {
            call.isVideo = !!WABinary_1.getBinaryNodeChild(infoChild, 'video')
            call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid']
            call.groupJid = infoChild.attrs['group-jid']
            callOfferCache.set(call.id, call)
        }
        
        const existingCall = callOfferCache.get(call.id)
        
        if (existingCall) {
            call.isVideo = existingCall.isVideo
            call.isGroup = existingCall.isGroup
        }
        
        if (status === 'reject' || status === 'accept' || status === 'timeout' || status === 'terminate') {
            callOfferCache.del(call.id)
        }
        
        ev.emit('call', [call])
        
        await sendMessageAck(node)
    }
    
    const handleBadAck = async ({ attrs }) => {
        const key = { remoteJid: attrs.from, fromMe: true, id: attrs.id }
        
        if (attrs.error) {
            logger.warn({ attrs }, 'received error in ack')
            ev.emit('messages.update', [
                {
                    key,
                    update: {
                        status: Types_1.WAMessageStatus.ERROR,
                        messageStubParameters: [
                            attrs.error
                        ]
                    }
                }
            ])
        }
    }
    
    const processNodeWithBuffer = async (node, identifier, exec) => {
        ev.buffer()
        await execTask()
        ev.flush()
        function execTask() {
            return exec(node, false)
                .catch(err => onUnexpectedError(err, identifier))
        }
    }
    
    const makeOfflineNodeProcessor = () => {
        const nodeProcessorMap = new Map([
            ['message', handleMessage],
            ['call', handleCall],
            ['receipt', handleReceipt],
            ['notification', handleNotification]
        ])
        
        const nodes = []
        let isProcessing = false
        
        const enqueue = (type, node) => {
            nodes.push({ type, node })
            
            if (isProcessing) {
                return
            }
            
            isProcessing = true
            
            const promise = async () => {
                while (nodes.length && ws.isOpen) {
                    const { type, node } = nodes.shift()
                    const nodeProcessor = nodeProcessorMap.get(type)
                    if (!nodeProcessor) {
                        onUnexpectedError(new Error(`unknown offline node type: ${type}`), 'processing offline node')
                        continue
                    }
                    await nodeProcessor(node)
                }
                isProcessing = false
            }
            promise().catch(error => onUnexpectedError(error, 'processing offline nodes'))
        }
        
        return { enqueue }
    }
    
    const offlineNodeProcessor = makeOfflineNodeProcessor()
    
    const processNode = (type, node, identifier, exec) => {
        const isOffline = !!node.attrs.offline
        
        if (isOffline) {
            offlineNodeProcessor.enqueue(type, node)
        }
        
        else {
            processNodeWithBuffer(node, identifier, exec)
        }
    }
    
    ws.on('CB:message', (node) => {
        processNode('message', node, 'processing message', handleMessage)
    })
    ws.on('CB:call', async (node) => {
        processNode('call', node, 'handling call', handleCall)
    })
    ws.on('CB:receipt', node => {
        processNode('receipt', node, 'handling receipt', handleReceipt)
    })
    ws.on('CB:notification', async (node) => {
        processNode('notification', node, 'handling notification', handleNotification)
    })
    ws.on('CB:ack,class:message', (node) => {
        handleBadAck(node)
            .catch(error => onUnexpectedError(error, 'handling bad ack'))
    })
    ev.on('call', ([call]) => {
        if (call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
            const msg = {
                key: {
                    remoteJid: call.chatId,
                    id: call.id,
                    fromMe: false
                },
                messageTimestamp: Utils_1.unixTimestampSeconds(call.date),
            }
            
            if (call.status === 'timeout') {
                if (call.isGroup) {
                    msg.messageStubType = call.isVideo ? Types_1.WAMessageStubType.CALL_MISSED_GROUP_VIDEO : Types_1.WAMessageStubType.CALL_MISSED_GROUP_VOICE
                }
                
                else {
                    msg.messageStubType = call.isVideo ? Types_1.WAMessageStubType.CALL_MISSED_VIDEO : Types_1.WAMessageStubType.CALL_MISSED_VOICE
                }
            }
            
            else {
                msg.message = { call: { callKey: Buffer.from(call.id) } }
            }
            
            const protoMsg = WAProto_1.proto.WebMessageInfo.fromObject(msg)
            upsertMessage(protoMsg, call.offline ? 'append' : 'notify')
        }
    })
    
    ev.on('connection.update', ({ isOnline }) => {
        if (typeof isOnline !== 'undefined') {
            sendActiveReceipts = isOnline
            logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`)
        }
    })
    
    return {
        ...suki,
        sendMessageAck,
        sendRetryRequest,
        offerCall, 
        rejectCall,
        fetchMessageHistory,
        requestPlaceholderResend,
        messageRetryManager
    }
}

module.exports = {
  makeMessagesRecvSocket
}
