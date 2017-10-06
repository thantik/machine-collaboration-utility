/* global logger */
/*******************************************************************************
 * FakeMarlinConnection.js
 *
 * A class to manage opening, maintaining, and closing a serial connection.
 * This class wraps a serialport connection and mostly cleanly handles the data
 * stream following open so that we settle into a clean state to match commands
 * with responses.
 ******************************************************************************/
const _ = require('lodash');
const delay = require('bluebird').delay;
const MCE = require('motion-controller-emulator');

const roundAxis = function roundAxis(command, axis, self) {
  let roundedCommand = command;
  try {
    if (roundedCommand.indexOf(axis) !== -1) {
      const axisArray = roundedCommand.split(axis);
      const before = axisArray[0];
      const splitArray = axisArray[1].split(' ');
      const middle = axis + Number(splitArray[0]).toFixed(4);
      let end = '';
      if (splitArray.length > 1) {
        for (let i = 1; i < splitArray.length; i++) {
          end += ` ${splitArray[i]}`;
        }
      }
      roundedCommand = before + middle + end;
    }
  } catch (ex) {
    logger.error('Round Axis error', command, axis, ex);
  }
  return roundedCommand;
};

const roundGcode = function roundGcode(inGcode, self) {
  let gcode = inGcode;
  try {
    if (inGcode.indexOf('G1') !== -1) {
      gcode = roundAxis(gcode, 'X', self);
      gcode = roundAxis(gcode, 'Y', self);
      gcode = roundAxis(gcode, 'Z', self);
      gcode = roundAxis(gcode, 'E', self);
      gcode = roundAxis(gcode, 'F', self);
    }
  } catch (ex) {
    logger.error('Error index of G1', inGcode, ex);
  }
  return gcode;
};


/**
 * VirtualConnection()
 *
 * Simulates responses generated by Marlin Firmware
 *
 * User defined callbacks can be set for processing data, close and error
 *
 * Args:   inComName       - name of our com port
 *         inBaud          - baud rate
 *         inOpenPrimeStr  - string of commands to prime the connection
 *         inInitDataFunc  - passed opening sequence data (inInitDataFunc(inData))
 *         inConnectedFunc - function to call when we have successfully
 *                           connected
 * Return: N/A
 */
const VirtualConnection = function VirtualConnection(app, connectedFunc) {
  this.app = app;
  this.bot = new MCE();
  this.mCloseFunc = undefined;
  this.mErrorFunc = undefined;
  this.mDataFunc = connectedFunc;
  this.returnString = '';
  this.io = app.io;

  this.bot.open(() => {})
  .then(() => {
    connectedFunc(this);
  });
};

/* ******************************************************************************
 * Public interface
 * *****************************************************************************/

/**
 * setDataFunc(), setCloseFunc, setErrorFunc()
 *
 * Set the user configurable functions to call when we receive data,
 * close the port or have an error on the port.
 */
VirtualConnection.prototype.setDataFunc = function setDataFunc(inDataFunc) {
  this.mDataFunc = inDataFunc;
};
VirtualConnection.prototype.setCloseFunc = function setCloseFunc(inCloseFunc) {
  this.mCloseFunc = inCloseFunc;
};
VirtualConnection.prototype.setErrorFunc = function setErrorFunc(inErrorFunc) {
  this.mErrorFunc = inErrorFunc;
};

VirtualConnection.prototype.processData = function processData(inData) {
  const data = inData.toString();
  this.returnString += data;

  if (data.includes('ok')) {
    if (_.isFunction(this.mDataFunc)) {
      this.mDataFunc(String(this.returnString));
      this.returnString = '';
    }
  }
};

/**
 * send()
 *
 * Send a command to the device
 *
 * Args:   inCommandStr - string to send
 * Return: N/A
 */
VirtualConnection.prototype.send = function send(inCommandStr) {
  let gcode = roundGcode(inCommandStr).split('\n')[0];
  let error;
  let commandSent = false;

  try {
    // TODO add GCODE Validation regex
    // Add a line break if it isn't in there yet

    this.io.broadcast('botSent', gcode);
    this.bot.sendGcode(gcode)
    .then(reply => {
      this.io.broadcast('botReply', reply);
      logger.silly('reply:', reply);
      this.processData(reply);
    });
    logger.silly('sent :', gcode);

    commandSent = true;
  } catch (inError) {
    error = inError;
  }

  if (!commandSent) {
    // logger.error('Cannot send commands if not connected:', this.mState, error);
  }
};

/**
 * close()
 *
 * Close our connection
 *
 * Args:   N/A
 * Return: N/A
 */
VirtualConnection.prototype.close = function close() {
  if (_.isFunction(this.mCloseFunc)) {
    this.mCloseFunc();
  }
};

module.exports = VirtualConnection;
