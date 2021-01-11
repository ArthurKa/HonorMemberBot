'use strict';

module.exports = {
  data: {},
  working: {},
  addMessage(id, msg) {
    if(!this.data[id]) {
      this.data[id] = [];
    }
    this.data[id].push(msg);
  },
  isFree(id) {
    return !this.working[id];
  },
  setBusy(id) {
    this.working[id] = true;
  },
  setFree(id) {
    this.working[id] = false;
  },
  getMessage(id) {
    return this.data[id].shift();
  },
};
