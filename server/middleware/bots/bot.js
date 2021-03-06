/* global logger */
const StateMachine = require('javascript-state-machine');
const _ = require('lodash');
const uuidGenerator = require('uuid/v4');
const path = require('path');

const SerialCommandExecutor = require('./comProtocols/serial/executor');
const TelnetExecutor = require('./comProtocols/telnet/executor');
const VirtualExecutor = require('./comProtocols/virtual/executor');
const CommandQueue = require('./commandQueue');

const botFsmDefinitions = require('./botFsmDefinitions');

/**
 * This is a Bot class representing hardware that can process jobs.
 * All commands to the bot are passed to it's queue and processed sequentially
 *
 * @param {Object} app - The parent Koa app.
 * @param {Object} inputSettings - Details about the bot which are stored and can be changed
 * @param {Object} info - Details about the bot which are static
 * @param {Object} commands - Functions which can be executed by the bot
 *
 */
class Bot {
  constructor(app, presets, inputSettings) {
    this.app = app;

    // Since we will edit settings, we want a clone of the default settings
    this.settings = Object.assign({}, presets.settings);
    _.extend(this.settings, inputSettings);
    // Add a UUID if one doesn't exist yet
    this.settings.uuid = this.settings.uuid || uuidGenerator();

    this.info = presets.info;

    this.commands = presets.commands;

    this.commands.initialize(this);

    this.fsm = this.createStateMachine();

    this.checksumRunaway = false; // Variable to keep track of when a checksum creates an infinite loop
    this.checksumFailCount = 0;
    this.checksumFailThreshold = 100; // Number of failures to count before calling it a runaway
    this.checksumFailWindow = 2000; // Time before resetting a fail count

    this.discover();
  }

  createStateMachine() {
    const fsm = StateMachine.create({
      initial: 'uninitialized',
      error: (one, two) => {
        const errorMessage = `Invalid ${this.settings
          .name} bot state change action "${one}". State at "${two}".`;
        logger.error(errorMessage);
        throw new Error(errorMessage);
      },
      events: botFsmDefinitions.fsmEvents,
      callbacks: {
        onenterstate: (event, from, to) => {
          logger.info(
            `Bot ${this.settings.name} event ${event}: Transitioning from ${from} to ${to}.`,
          );
          try {
            this.app.io.broadcast('botEvent', {
              uuid: this.settings.uuid,
              event: 'update',
              data: this.getBot(),
            });
          } catch (ex) {
            logger.error('Update bot socket error', ex);
          }
        },
      },
    });
    return fsm;
  }

  /*
  * get a json friendly description of the Bot
  */
  getBot() {
    let currentJob;
    if (this.settings.model !== 'Remote') {
      currentJob = this.currentJob === undefined ? undefined : this.currentJob.getJob();
    } else {
      currentJob = this.currentJob;
    }
    return {
      state:
        this.fsm !== undefined && this.fsm.current !== undefined ? this.fsm.current : 'unavailable',
      status: this.status,
      settings: this.settings,
      info: this.info,
      port: this.port,
      currentJob,
      warnings: this.warnings,
    };
  }

  async updateBot(newSettings) {
    // parse the existing settings
    // if any of the settings passed in match the existing settings
    // add them to "settingsToUpdate" object.

    // NOTE if we are passing object details that do not match existing settings
    // we don't throw an error, we just ignore them
    const settingsToUpdate = {};

    _.entries(newSettings).forEach(([settingKey, settingValue]) => {
      if (this.settings[settingKey] !== undefined) {
        settingsToUpdate[settingKey] = settingValue;
      }
    });

    if (typeof settingsToUpdate.custom === 'object') {
      settingsToUpdate.custom = JSON.stringify(settingsToUpdate.custom);
    }

    // If the bot is persistent, then update the database with new settings
    const dbBots = await this.app.context.bots.BotModel.findAll();
    const dbBot = _.find(dbBots, bot => bot.dataValues.uuid === this.settings.uuid);

    // Update the database
    if (dbBot !== undefined) {
      logger.info(
        `About to update bot ${this.settings.name} settings from ${JSON.stringify(
          this.settings,
        )} to ${JSON.stringify(settingsToUpdate)}`,
      );
      await dbBot.update(settingsToUpdate);
    }

    // Revert the custom database field to a json object
    if (typeof settingsToUpdate.custom === 'string') {
      settingsToUpdate.custom = JSON.parse(settingsToUpdate.custom);
    }

    // pass the new settings to the bot's setting object
    _.entries(settingsToUpdate).forEach(([settingKey, settingValue]) => {
      if (this.settings[settingKey] !== undefined) {
        this.settings[settingKey] = settingValue;
      }
    });

    this.app.io.broadcast('botEvent', {
      uuid: this.settings.uuid,
      event: 'update',
      data: this.getBot(),
    });

    return this.getBot();
  }

  /*
   * Set the port of the bot.
   */
  setPort(port) {
    // Validate?
    this.port = port;
  }

  /*
   * This is the logic for parsing any commands sent to the Bot API
   * In all cases, the API does not wait for the command to be completed, instead
   * the bot enters the appropriate transitional state, followed by either
   * "done" or "fail" events and corresponding state transitions
   */
  async processCommand(command, params) {
    const commandObj = this.commands[command];

    if (typeof commandObj !== 'function') {
      throw new Error(`Command ${command} not supported.`);
    }

    // TODO Consider always returning get bot plus any info or error, instead
    let reply;
    try {
      reply = await commandObj(this, params);
    } catch (ex) {
      throw new Error(ex);
    }

    return reply;
  }

  // Set up the appropriate command executor and validator for a given connection type
  discover(params = {}) {
    // Allow immediate discovery of virtual hardware or real hardware when the
    if (this.info.connectionType !== 'serial' || params.realHardware === true) {
      this.fsm.discover();
      try {
        let executor;
        let validator;
        // Set up the validator and executor
        switch (this.info.connectionType) {
          case 'serial': {
            const openPrime =
              this.settings.openString == undefined ? 'M501' : this.settings.openString;

            const executorObject = {
              app: this.app,
              port: this.port,
              baudrate: this.info.baudrate,
              openPrime,
              bot: this,
            };
            executor = new SerialCommandExecutor(executorObject);

            validator = this.validateSerialReply;
            break;
          }
          case 'virtual':
          case 'conductor': {
            const executorObject = {
              app: this.app,
              bot: this,
            };
            executor = new VirtualExecutor(executorObject);
            validator = this.validateSerialReply;
            break;
          }
          case 'remote': {
            executor = new VirtualExecutor({ app: this.app });
            validator = this.validateSerialReply;
            break;
          }
          case 'telnet': {
            executor = new TelnetExecutor({
              app: this.app,
              externalEndpoint: this.settings.endpoint,
            });
            validator = this.validateSerialReply;
            break;
          }
          default: {
            const errorMessage = `connectionType "${this.info.connectionType}" is not supported.`;
            throw new Error(errorMessage);
          }
        }

        // Set up the bot's command queue
        this.queue = new CommandQueue(executor, this.expandCode, _.bind(validator, this));

        this.fsm.initializationDone();
      } catch (ex) {
        logger.error(ex);
        this.fsm.initializationFail();
      }
    }
  }

  /**
   * expandCode()
   *
   * Expand simple commands to gcode we can send to the bot
   *
   * Args:   code - a simple string gcode command
   * Return: a gcode string suitable for the hardware
   */
  expandCode(code) {
    return `${code}\n`;
  }

  /**
   * validateSerialReply()
   *
   * Confirms if a reply contains 'ok' as its last line.  Parses out DOS newlines.
   *
   * Args:   reply - The reply from a bot after sending a command
   * Return: true if the last line was 'ok'
   */
  validateSerialReply(command, reply) {
    let ok;
    try {
      // In case of line break between ok
      // TODO consider more stringent parsing of ok
      ok = reply.replace('\n', '').includes('ok');
    } catch (ex) {
      logger.error('Bot validate serial reply error', reply, ex);
    }

    if (
      this.info.checksumSupport &&
      (reply.toLowerCase().includes('resend') || reply.substring(0, 2) === 'rs') &&
      !this.checksumRunaway
    ) {
      // If there was a snag, prepend the command and try again
      // Try to send the command again
      this.queue.prependCommands(command.code);

      // Keep track of how many times we've tried to resend
      this.checksumFailCount += 1;
      setTimeout(() => {
        this.checksumFailCount -= 1;
      }, this.checksumFailWindow);

      if (this.checksumFailCount > this.checksumFailThreshold) {
        this.checksumRunaway = true;
        logger.error('Warning, checksum runaway. No longer sending lines with checksum');
      }
      return true;
    }
    return ok;
  }

  /**
   * validateVirtualReply()
   *
   * Confirms if a reply contains 'ok' as its last line.  Parses out DOS newlines.
   *
   * Args:   reply - The reply from a bot after sending a command
   * Return: true if the last line was 'ok'
   */
  validateVirtualReply(command, reply) {
    const lines = reply.toString().split('\n');
    const ok = _.last(lines).indexOf('ok') !== -1;
    return ok;
  }

  /**
   * addOffset()
   *
   * Takes a gcode command and offsets per the bots settings, if a G0 or G1 command is issued
   *
   * Args:   gcodeObject - The command to be offset
   * Return: offsetObject - The offset gcode Object
   */
  addOffset(gcodeObject) {
    if (gcodeObject.command === 'G0' || gcodeObject.command === 'G1') {
      if (gcodeObject.args.x) {
        gcodeObject.args.x += Number(this.settings.offsetX);
      }
      if (gcodeObject.args.y) {
        gcodeObject.args.y += Number(this.settings.offsetY);
      }
      if (gcodeObject.args.z) {
        gcodeObject.args.z += Number(this.settings.offsetZ);
      }
    }
  }
}

module.exports = Bot;
