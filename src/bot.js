'use strict';

process.env.NTBA_FIX_319 = 1;   // Some one fix of node-telegram-bot-api

const TelegramBot = require('node-telegram-bot-api');
const config = require('config');

module.exports = new TelegramBot(config.get('botToken'), { polling: true });
module.exports.msg = function(a, b) {
  return this.sendMessage(a, b, { parse_mode: 'markdown' });
}
