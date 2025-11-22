"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const Defaults_1 = require("../Defaults")
const communities_1 = require("./community")

const makeWASocket = (config) => {
    const newConfig = {
        ...Defaults_1.DEFAULT_CONNECTION_CONFIG,
        ...config
    }

    if (config.shouldSyncHistoryMessage === undefined) {
        newConfig.shouldSyncHistoryMessage = () => !!newConfig.syncFullHistory
    }

    return communities_1.makeCommunitiesSocket(newConfig)
}

exports.default = makeWASocket
