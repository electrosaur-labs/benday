'use strict';

let nextSaveResponse = undefined;
let nextOpenResponse = undefined;
const savedFiles = [];

const localFileSystem = {
  async getFileForSaving(defaultName) {
    if (typeof nextSaveResponse === 'function') {
      return await nextSaveResponse(defaultName);
    }
    if (nextSaveResponse !== undefined) {
      const res = nextSaveResponse;
      nextSaveResponse = undefined;
      return res;
    }
    const entry = {
      name: defaultName || 'benday.json',
      content: '',
      async write(text) {
        this.content = String(text);
        savedFiles.push({ name: this.name, content: this.content });
      },
    };
    return entry;
  },

  async getFileForOpening(opts) {
    if (typeof nextOpenResponse === 'function') {
      return await nextOpenResponse(opts);
    }
    if (nextOpenResponse !== undefined) {
      const res = nextOpenResponse;
      nextOpenResponse = undefined;
      return res;
    }
    return null;
  },
};

module.exports = {
  entrypoints: {
    setup: () => {},
  },
  storage: {
    localFileSystem,
  },
  __mockUxpStorage: {
    savedFiles,
    reset() {
      savedFiles.length = 0;
      nextSaveResponse = undefined;
      nextOpenResponse = undefined;
    },
    setNextSaveResponse(val) {
      nextSaveResponse = val;
    },
    setNextOpenText(text, name = 'Loaded-benday.json') {
      nextOpenResponse = {
        name,
        async read() {
          return text;
        },
      };
    },
    setNextOpenResponse(val) {
      nextOpenResponse = val;
    },
  },
};
