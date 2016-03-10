/*******************************************************************************
 * tcpConnection.js
 *
 * A class to manage opening, maintaining, and closing a tcp connection.
 * // TODO replace http requests with socket communication
 ******************************************************************************/
var _ = require('underscore'),
    Heartbeat = require('heartbeater');
let logger;

var request = require(`request-promise`);
/**
 * TCPConnection()
 *
 * Manages a tcp connection.
 *
 *
 * User defined callbacks can be set for processing data, close and error
 *
 * Args:   externalEndpoint - external url that we are communicating with
 *         inInitDataFunc  - passed opening sequence data (inInitDataFunc(inData))
 *         inConnectedFunc - function to call when we have successfully
 *                           connected
 * Return: N/A
 */
class TCPConnection {
  constructor(externalEndpoint, doneFunction) {
    this.externalEndpoint = externalEndpoint;
    this.doneFunction = doneFunction;

    // User configurable data callback and close notification.  Our initial
    // data function handles the open sequence.
    this.mDataFunc = undefined;
    this.mCloseFunc = undefined;
    this.mErrorFunc = undefined;

    // A hack. Normally we would validate the connection and then call this function
    // once we are validated
    doneFunction(this);
  }

  /*******************************************************************************
   * Public interface
   *******************************************************************************/
  /**
   * setDataFunc(), setCloseFunc, setErrorFunc()
   *
   * Set the user configurable functions to call when we receive data,
   * close the port or have an error on the port.
   */
  setDataFunc(inDataFunc) {
    this.mDataFunc = inDataFunc;
  }

  setCloseFunc(inCloseFunc) {
    this.mCloseFunc = inCloseFunc;
  }

  setErrorFunc(inErrorFunc) {
    this.mErrorFunc = inErrorFunc;
  }

  /**
   * send()
   *
   * Send a command to the device
   *
   * Args:   inCommandStr - string to send
   * Return: N/A
   */
  async send(inCommandStr) {
    var error = undefined;
    var commandSent = false;

    try {
      const requestParams = {
        method: `POST`,
        uri: `${this.externalEndpoint}/v1/bot/processGcode`,
        body: { gcode: inCommandStr },
        json: true,
      };

      const reply = await request(requestParams);
      if (_.isFunction(this.mDataFunc)) {
        this.mDataFunc(reply);
      }
      commandSent = true;
    } catch (ex) {
      setTimeout(() => {
        this.send(inCommandStr);
      }, 1000);
    }
  }

  /**
   * close()
   *
   * Close our connection
   *
   * Args:   N/A
   * Return: N/A
   */
   close() {
    console.log('closing!');
  }
}

module.exports = TCPConnection;
