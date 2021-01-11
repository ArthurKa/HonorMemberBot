'use strict';

const { declineWrapper } = require('decline-word');
const config = require('config');
const bot = require('./bot.js');
const db = require('./db.js');
const messageBox = require('./messageBox.js');

const wait = (a, b = a) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (b - a)) + a));

const defaultChatData = { chosen: {}, lockSeconds: 4*3600, maxChosenSeconds: 24*3600 };

(async () => {
  const usersCollection = await db('users');
  const chatsCollection = await db('chats');

  async function migrateGroupFromPrivateToPublic({ chat: { id }, migrate_to_chat_id = null }) {
    if(migrate_to_chat_id) {
      await usersCollection.updateMany({ chatId: id }, { $set: { chatId: migrate_to_chat_id } } );
    }
  }

  async function checkIsAdmin({ chat, from }) {
    const { status } = await bot.getChatMember(chat.id, from.id);
    return ['creator', 'administrator'].includes(status);
  }

  function checkIsPersonalChat({ chat: { id: chatId }, from: { id: userId } }) {
    return chatId === userId;
  }

  const processMember = {
    async helper(chatId, { is_bot, ...user }, left) {
      if(left && user.id === config.get('botId')) {
        await usersCollection.updateMany({ chatId }, { $set: { left } } );
      }
      if(is_bot) {
        return;
      }
      const query = { chatId, 'user.id': user.id };
      const [document] = await usersCollection.find(query).toArray();
      if(!document) {
        await usersCollection.insertOne({ chatId, user, left, blocked: false, noping: false, chosen: { timeMilliseconds: 0 }, rating: 1 });
      } else {
        await usersCollection.updateOne(query, { $set: { user, left } });
      }
    },
    regular(...args) {
      return this.helper(...args, false);
    },
    left(...args) {
      return this.helper(...args, true);
    },
  };
  async function processChatMembers({ chat, from, new_chat_members = [], left_chat_member = null }) {
    await processMember.regular(chat.id, from);
    for(const newMember of new_chat_members) {
      await processMember.regular(chat.id, newMember);
    }
    if(left_chat_member) {
      await processMember.left(chat.id, left_chat_member);
    }
  }

  async function processPersonalChat(msg, commands, allowedCommands = [], allowedPersonalCommands = []) {
    const { chat: { id: chatId }, from: { id: userId } } = msg;
    const allCommands = [
      ...allowedCommands.map(e => [e, true]),
      ...allowedPersonalCommands.map(e => [e, false]),
    ];

    // if(commands.match('tag', msg)) {
    //   let asd = await usersCollection.find({}).toArray();
    //   asd = asd.map(e => formUser({ user: e.user }));
    //   await bot.msg(chatId, asd.toString());
    //   return true;
    // }

    if(checkIsPersonalChat(msg) && !allCommands.some(([e, x]) => commands.match(e, msg, x))) {
      await bot.msg(chatId, 'В личной переписке можно получить только помощь в использовании бота: /help, а также оставить сообщение для разработчика: `/dev <сообщение>`.\nЕго полный функционал раскрывается лишь в групповом чате.');
      return true;
    }
    return false;
  }

  const escape = (str = '') => str.replace(/[_*`[]/g, '\\$&');
  function formUserName({ first_name, last_name, username }, noping) {
    if(noping && username) {
      return escape(username);
    }
    const name = [escape(first_name), escape(last_name)].filter(Boolean).join(' ');
    return noping ? name.replace(/@/g, '') : name;
  }
  function formUser({ user, noping, blocked }) {
    const userName = formUserName(user, noping || blocked);
    return noping || blocked ? userName : `[${userName}](tg://user?id=${user.id})`;
  }
  function formTimeLeft(timeInMilliseconds, ending = 'у') {
    const words = [
      declineWrapper('д', 'ень', 'ня', 'ней'),
      declineWrapper('час', '', 'а', 'ов'),
      declineWrapper('минут', ending, 'ы'),
      declineWrapper('секунд', ending, 'ы'),
    ];
    const thresholds = [1000, 60, 60, 24];

    const time = thresholds.reduce((acc, cur, i, thresholds) => {
      const [prevTime] = acc[i-1] || [];
      const time = prevTime == null ? timeInMilliseconds : prevTime;
      acc.push([Math.floor(time / cur), thresholds[i+1]]);
      return acc;
    }, []).map(([time, n]) => n == null ? time : time % n).reverse();

    const i = Math.min(time.findIndex(e => e !== 0), 2);
    return [i, i+1]
      .map(i => [time[i], words[i]])
      .filter(e => e[0])
      .map(([time, word]) => `${time} ${word(time)}`).join(' ');
  }

  function countRating(users) {
    const total = users.reduce((acc, e) => acc + e.rating, 0);
    for(const user of users) {
      user.relativeRating = user.rating / total;
    }
  }
  function getGradation(percents) {
    const arr = percents.reduce((acc, cur) => {
      acc.push(cur + (acc[acc.length-1] || 0));
      return acc;
    }, []);
    arr[arr.length - 1] = 1;
    return arr;
  }
  function chooseUser([...users], oldUser = null) {
    if(oldUser) {
      users = users.filter(e => e !== oldUser);
    }
    countRating(users);

    const rand = Math.random();
    const i = getGradation(users.map(e => e.relativeRating)).findIndex(e => rand <= e);
    return users[i];
  }
  function formRelativeRating({ relativeRating }) {
    return `${+(relativeRating * 100).toFixed(2)}%`;
  }

  const commands = {
    match(str, { text = '' }, isNotPersonal = true) {
      const reStr = isNotPersonal ? `^/${str}(?:@${config.get('botName')})?$` : `^/${str}`;
      const match = text.match(new RegExp(reStr, 'i'));
      return match ? match.slice(1) : false;
    },
    async members({ chat: { id: chatId } }) {
      function formUserList(users) {
        return users.map(e => {
          const sign =  e.blocked ? '❌' : '✅';
          const command =  e.blocked ? 'recover' : 'remove';
          return `${sign} ${formUser(e)} — /${command}${e.user.id}`;
        }).join('\n');
      }

      const users = await usersCollection.find({ chatId, left: false })
        .toArray()
        .then(e => e.sort((a, b) => a.blocked - b.blocked));
      if(users.length) {
        await bot.msg(chatId, `Все участники:\n${formUserList(users)}`);
      } else {
        await bot.msg(chatId, 'Нет участников.');
      }
    },
    async remove(msg, userId) {
      const chatId = msg.chat.id;
      if(!await checkIsAdmin(msg)) {
        return void await bot.msg(chatId, 'Вы не являетесь администратором.');
      }
      const { result: { n, nModified } } = await usersCollection.updateOne({ chatId, 'user.id': userId }, { $set: { blocked: true } });
      if(n && nModified) {
        const [user] = await usersCollection.find({ chatId, 'user.id': userId }).toArray();
        await bot.msg(chatId, `Пользователь ${formUser(user)} успешно удалён.\nВосстановить: /recover${userId}.`);
      } else {
        await bot.msg(chatId, 'Нет такого пользователя.');
      }
    },
    async recover(msg, userId) {
      const chatId = msg.chat.id;
      if(!await checkIsAdmin(msg)) {
        return void await bot.msg(chatId, 'Вы не являетесь администратором.');
      }
      const { result: { n, nModified } } = await usersCollection.updateOne({ chatId, 'user.id': userId }, { $set: { blocked: false } });
      if(n && nModified) {
        const [user] = await usersCollection.find({ chatId, 'user.id': userId }).toArray();
        await bot.msg(chatId, `Пользователь ${formUser(user)} успешно восстановлен.`);
      } else {
        await bot.msg(chatId, 'Нет такого пользователя.');
      }
    },
    async choose({ from: { id: userId },chat: { id: chatId } }) {
      const [chat = defaultChatData] = await chatsCollection.find({ chatId }).toArray();

      const now = new Date();
      const thresholdTime = new Date(now - chat.chosen.lockSeconds * 1000);
      if(chat.chosen.time > thresholdTime) {
        const [user] = await usersCollection.find({ chatId, 'user.id': chat.chosen.userId }).toArray();
        await bot.msg(chatId, `Почётный участник: ${formUser(user)}.\nПереизбрать почётного участника можно будет не раньше чем через ${formTimeLeft(chat.chosen.time - thresholdTime) || 'мгновение ока'}.`);
        return;
      }
      if(chat.chosen.time <= thresholdTime) {
        const time = Math.min(now - chat.chosen.time, chat.maxChosenSeconds * 1000);
        await usersCollection.updateOne({ chatId, 'user.id': chat.chosen.userId }, { $inc: { 'chosen.timeMilliseconds': time } });
      }

      const users = await usersCollection.find({ chatId, left: false, blocked: false }).toArray();
      if(!users.length) {
        await bot.msg(chatId, 'Недостаточно участников для участия в выборе "почётного участника".');
        return;
      }

      let chosenUser = [chooseUser(users)];
      if(users.length > 1 && Math.random() > 0.6) {
        await bot.msg(chatId, `Почётным участником на ${formTimeLeft(chat.lockSeconds * 1000)} стал(а): ${formUser(chosenUser[0])}.`);
        await wait(500, 3000);
        const waitPhrases = [
          'Погодите-ка...',
          'Хотя...',
          'Минуточку...',
        ];
        await bot.msg(chatId, waitPhrases[Math.floor(Math.random() * waitPhrases.length)]);
        await wait(500, 3000);
        const noPhrases = [
          'Охрана, отмєна!',
          'Галя, отмена!',
          'Нет, я передумал)',
          'Хм... Повезёт в следующий раз)',
          'Эх. Не повезло тебе в этот раз...',
          // 'Ладно, ладно. Я пошутил.',
        ];
        await bot.msg(chatId, noPhrases[Math.floor(Math.random() * noPhrases.length)]);
        chosenUser.unshift(chooseUser(users, chosenUser[0]));
        await wait(500, 3000);
      }

      const chosen = {
        userId: chosenUser[0].user.id,
        time: now,
        lockSeconds: chat.lockSeconds,
      };
      if(chat === defaultChatData) {
        await chatsCollection.insertOne({
          chatId,
          ...chat,
          chosen,
        });
      } else {
        await chatsCollection.updateOne({ chatId }, { $set: { chosen } });
      }

      await bot.msg(chatId, `Почётным участником на ${formTimeLeft(chat.lockSeconds * 1000)} стал(а): ${formUser(chosenUser[0])}.`);
      if(chosenUser[chosenUser.length-1].user.id !== userId) {
        const user = users.find(e => e.user.id === userId);
        user.rating += 0.2;
        countRating(users);
        await bot.msg(chatId, `А твоя вероятность быть избранным теперь составляет ${formRelativeRating(user)}.`);
        await usersCollection.updateOne({ chatId, 'user.id': userId }, { $set: { rating: +user.rating.toFixed(5) } });
      }
    },
    async top({ chat: { id: chatId } }) {
      function formUserList(users) {
        return users.map(([e, lockTimeLeft = 0, maxChosenSeconds = 0], i) => {
          const time = formTimeLeft(e.chosen.timeMilliseconds, 'а');
          const userName = formUser(e);
          const userTime = time ? time : 'ещё ни разу не был(а)';
          const ending = lockTimeLeft >= 1000
            ? ` *(+ ${formTimeLeft(lockTimeLeft, 'а')})*`
            : maxChosenSeconds >= 1000
              ? ` *[+ ${formTimeLeft(maxChosenSeconds, 'а')}]*`
              : '';
          return `\`${i+1}. \`${userName} _(${formRelativeRating(e)})_ — ${userTime}${ending}`;
        }).join('\n');
      }

      const [chat = defaultChatData] = await chatsCollection.find({ chatId }).toArray();
      const users = await usersCollection.find({ chatId, left: false })
        .toArray()
        .then(users => {
          return users.map(e => {
            const arr = [e];
            if(e.user.id === chat.chosen.userId) {
              const now = Date.now();
              const time = Math.min(now - (chat.chosen.time || now), chat.maxChosenSeconds * 1000);
              e.chosen.timeMilliseconds += time;
              arr.push(+chat.chosen.time + chat.chosen.lockSeconds * 1000 - now);
              arr.push(+chat.chosen.time + chat.maxChosenSeconds * 1000 - now);
            }
            return arr;
          })
          .sort(([a], [b]) => b.chosen.timeMilliseconds - a.chosen.timeMilliseconds);
        });

      countRating(users.map(e => e[0]));

      if(users.length) {
        const mode = new Array(2).fill().map((_, i) => users.some(e => e[i+1] >= 1000));

        let infoEnding = '';
        if(!mode[0]) {
          infoEnding = `\n\n/choose — избрать${mode[1] ? ' нового' : ''} почётного участника.`;
        }

        await bot.msg(chatId, `Рейтинг почётных участников:\n${formUserList(users)}${infoEnding}`);
        if(mode[0] && Math.random() > 0.9) {
          const pingUsersAmount = users.reduce((n, [{ noping, blocked }]) => n + (!noping && !blocked), 0);
          await wait(500, 2000);
          if(pingUsersAmount * 2 >= users.length) {
            await bot.msg(chatId, `Мешают уведомления?\n/noping — поможет убрать их${pingUsersAmount === users.length ? '.' : ', а\n/pingon — вернёт их назад.'}`);
          } else {
            await bot.msg(chatId, `Не хватает уведомлений?\n/pingon — вернёт радость в вашу жизнь.`);
          }
        }
      } else {
        await bot.msg(chatId, 'Пока нет участников.');
      }
    },
    async noping({ chat: { id: chatId }, from: user, from: { id: userId } }) {
      const { result: { nModified: noping } } = await usersCollection.updateOne({ chatId, 'user.id': userId }, { $set: { noping: true } });
      if(noping) {
        // await bot.msg(chatId, `Хорошо, ${formUser({ user, noping })}, больше не побеспокою.`);
        await bot.msg(chatId, `${formUser({ user, noping })}, прошу прощения. Зря быканул.`);
      } else {
        await bot.msg(chatId, `${formUser({ user, noping: !noping })}, для тебя ведь уведомления и так уже выключены...`);
      }
    },
    async pingon({ chat: { id: chatId }, from: user, from: { id: userId } }) {
      const { result: { nModified: noping } } = await usersCollection.updateOne({ chatId, 'user.id': userId }, { $set: { noping: false } });
      if(noping) {
        await bot.msg(chatId, `${formUser({ user, noping: !noping })}, уведомления включены назад.`);
      } else {
        await bot.msg(chatId, `${formUser({ user, noping })}, но ведь для тебя уведомления и так включены...`);
      }
    },
    async help({ chat: { id: chatId }, from: user, from: { id: userId } }) {
      await bot.msg(chatId, `
        Некоторая помощь в использовании бота:

        ✓ /choose — избрать почётного участника среди всех участвующих.
        Участники регистрируются автоматически.
        За один раз "почётный участник" избирается не более чем на 1 день и не может быть переизбран раньше чем через 4 часа.

        ✓ /top — просмотр списка "самых почётных" участников, а также их вероятностей.

        ✓ /members — просмотр списка всех участников. Символом «✅» помечены те, кто участвует в выборе почётного участника, «❌» — нет.
        С помощью команд \`/remove<id>\` и \`/recover<id>\` можно управлять участниками, которые участвуют в выборе.

        Бот иногда отвечает сообщениями с упоминанием участников. Упоминания можно отключить индивидуально в частном порядке.
        ✓ /noping — если вдруг надоели уведомления.
        ✓ /pingon — если хотите включить уведомления назад.

        Ваши пожелания и предложения можно писать боту лично. Приятного использования!
      `.split('\n').map(e => e.trim()).join('\n'));
    },
    async dev(msg, message = '') {
      if(!checkIsPersonalChat(msg)) {
        return;
      }

      const { chat: { id: chatId }, from: user, from: { id: userId } } = msg;
      if(!message) {
        await bot.msg(chatId, 'К сожалению, сообщение не может быть пустым. Отправьте команду в виде:\n`/dev и следом текст сообщения`');
        return;
      }

      await bot.msg(config.get('developerId'), formUser({ user }));
      await bot.sendMessage(config.get('developerId'), message);
      await bot.msg(chatId, 'Спасибо. Сообщение было доставлено разработчику.');
    },
  };

  bot.on('message', async msg => {
    const chatId = msg.chat.id;
    messageBox.addMessage(chatId, msg);

    if(messageBox.isFree(chatId)) {
      messageBox.setBusy(chatId);

      let msg;
      while(msg = messageBox.getMessage(chatId)) {
        if(!await processPersonalChat(msg, commands, ['help'], ['dev([^@]|$)'])) {
          await migrateGroupFromPrivateToPublic(msg);
          await processChatMembers(msg);

          let groups;
          if(commands.match('members', msg)) {
            await commands.members(msg);
          } else if(groups = commands.match('remove(\\d+)', msg)) {
            await commands.remove(msg, +groups[0]);
          } else if(groups = commands.match('recover(\\d+)', msg)) {
            await commands.recover(msg, +groups[0]);
          } else if(commands.match('choose', msg)) {
            await commands.choose(msg);
          } else if(commands.match('top', msg)) {
            await commands.top(msg);
          } else if(commands.match('noping', msg)) {
            await commands.noping(msg);
          } else if(commands.match('pingon', msg)) {
            await commands.pingon(msg);
          } else if(commands.match('help', msg)) {
            await commands.help(msg);
          } else if(groups = commands.match('dev(?:(?:\\s+(.*))|$)', msg, false)) {
            await commands.dev(msg, groups[0]);
          }
        }
      }

      messageBox.setFree(chatId);
    }
  });

  console.info('Bot started.');
})();

/*

top - Show the top of honor participants
choose - Choose honor participant
members - Show all participants
noping - Turn off notifications
pingon - Turn on notifications
help - Show some help

*/
