'use strict'

const connect = require('it-ws/client')
const withIs = require('class-is')
const toUri = require('multiaddr-to-uri')
const { AbortError } = require('abortable-iterator')
const pDefer = require('p-defer')

const debug = require('debug')
const log = debug('libp2p:websockets')
log.error = debug('libp2p:websockets:error')
const env = require('ipfs-utils/src/env')

const createListener = require('./listener')
const toConnection = require('./socket-to-conn')
const filters = require('./filters')

/**
 * @typedef {import('multiaddr').Multiaddr} Multiaddr
 */

/**
 * @class WebSockets
 */
class WebSockets {
  /**
   * @class
   * @param {object} options
   * @param {Upgrader} options.upgrader
   * @param {(multiaddrs: Array<Multiaddr>) => Array<Multiaddr>} options.filter - override transport addresses filter
   */
  //constructor ({ upgrader, filter }) {
  constructor ({ debug, timeoutInterval, binaryType, upgrader, filter }) {
    if (!upgrader) {
      throw new Error('An upgrader must be provided. See https://github.com/libp2p/interface-transport#upgrader.')
    }
    this._upgrader = upgrader
    this._filter = filter
    ////////////////////////////////////////////////////////
    if (!('WebSocket' in window)) {
      return
    }

    // Default settings
    /** Whether this instance should log debug messages. */
    this.debug = debug ? debug : false

    /** The maximum time in milliseconds to wait for a connection to succeed before closing and retrying. */
    this.timeoutInterval = timeoutInterval ? timeoutInterval : 5000 //2000

    /** The binary type, possible values 'blob' or 'arraybuffer', default 'blob'. */
    this.binaryType = binaryType ? binaryType : 'arraybuffer' //'blob'

    // These should be treated as read-only properties
    /**
    * The current state of the connection.
    * Can be one of: WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED
    * Read only.
    */
    this.readyState = WebSocket.CONNECTING

    this.forcedClose = false

    this.timedOut = false

    // Private state variables
    var self = this
    this.eventTarget = document.createElement('div')

    // Wire up "on*" properties as event handlers
    this.eventTarget.addEventListener('open', function (event) { self.onopen(event) })
    this.eventTarget.addEventListener('close', function (event) { self.onclose(event) })
    this.eventTarget.addEventListener('connecting', function (event) { self.onconnecting(event) })
    this.eventTarget.addEventListener('message', function (event) { self.onmessage(event) })
    this.eventTarget.addEventListener('error', function (event) { self.onerror(event) })

    // Expose the API required by EventTarget
    this.addEventListener = this.eventTarget.addEventListener.bind(this.eventTarget)
    this.removeEventListener = this.eventTarget.removeEventListener.bind(this.eventTarget)
    this.dispatchEvent = this.eventTarget.dispatchEvent.bind(this.eventTarget)
    ////////////////////////////////////////////////////////
  }

  /**
   * @async
   * @param {Multiaddr} ma
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] - Used to abort dial requests
   * @returns {Connection} An upgraded Connection
   */
  async dial (ma, options = {}) {
    log('dialing %s', ma)

    const socket = await this._connect(ma, options)
    const maConn = toConnection(socket, { remoteAddr: ma, signal: options.signal })
    log('new outbound connection %s', maConn.remoteAddr)

    const conn = await this._upgrader.upgradeOutbound(maConn)
    log('outbound connection %s upgraded', maConn.remoteAddr)
    return conn
  }

  /**
   * @private
   * @param {Multiaddr} ma
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] - Used to abort dial requests
   * @returns {Promise<WebSocket>} Resolves a extended duplex iterable on top of a WebSocket
   */
  async _connect (ma, options = {}) {
    if (options.signal && options.signal.aborted) {
      throw new AbortError()
    }
    const cOpts = ma.toOptions()
    log('dialing %s:%s', cOpts.host, cOpts.port)

    const errorPromise = pDefer()
    const errfn = (err) => {
      const msg = `connection error: ${err.message}`
      log.error(msg)

      errorPromise.reject(err)
    }

    //const rawSocket = connect(toUri(ma), Object.assign({ binary: true }, options))
    ////////////////////////////////////////////////////////
    const rawSocket = connect(toUri(ma), Object.assign({ binaryType: this.binaryType }, options))
    this.ws = rawSocket.socket
    if (rawSocket.socket) {
      this.url = rawSocket.socket.url
    }
    var self = this

    var timeout = setTimeout(function () {
      if (self.debug) {
        console.debug('libp2p-websockets-curltech', 'connection-timeout', self.url)
      }
      self.timedOut = true
      self.ws.close()
      self.timedOut = false
    }, self.timeoutInterval)

    /**
     * This function generates an event that is compatible with standard
     * compliant browsers and IE9 - IE11
     *
     * This will prevent the error:
     * Object doesn't support this action
     *
     * http://stackoverflow.com/questions/19345392/why-arent-my-parameters-getting-passed-through-to-a-dispatched-event/19345563#19345563
     * @param s String The name that the event should use
     * @param args Object an optional object that the event will use
     */
    function generateEvent (s, args) {
      var evt = document.createEvent("CustomEvent")
      evt.initCustomEvent(s, false, false, args)
      return evt
    }

    this.ws.onopen = function (event) {
      clearTimeout(timeout)
      if (self.debug) {
        console.debug('libp2p-websockets-curltech', 'onopen', self.url)
      }
      self.readyState = WebSocket.OPEN
      var e = generateEvent('open')
      self.eventTarget.dispatchEvent(e)
    }

    this.ws.onclose = function (event) {
      clearTimeout(timeout)
      self.ws = null
      if (self.forcedClose) {
        self.readyState = WebSocket.CLOSED
        self.eventTarget.dispatchEvent(generateEvent('close'))
      } else {
        self.readyState = WebSocket.CONNECTING
        var e = generateEvent('connecting')
        e.code = event.code
        e.reason = event.reason
        e.wasClean = event.wasClean
        self.eventTarget.dispatchEvent(e)
        if (!self.timedOut) {
          if (self.debug) {
            console.debug('libp2p-websockets-curltech', 'onclose', self.url)
          }
          self.eventTarget.dispatchEvent(generateEvent('close'))
        }
      }
    }
    this.ws.onmessage = function (event) {
      if (self.debug) {
        console.debug('libp2p-websockets-curltech', 'onmessage', self.url, event.data)
      }
      var e = generateEvent('message')
      e.data = event.data
      self.eventTarget.dispatchEvent(e)
    }
    this.ws.onerror = function (event) {
      if (self.debug) {
        console.debug('libp2p-websockets-curltech', 'onerror', self.url, event)
      }
      self.eventTarget.dispatchEvent(generateEvent('error'))
    }
    ////////////////////////////////////////////////////////
    if (rawSocket.socket.on) {
      rawSocket.socket.on('error', errfn)
    } else {
      rawSocket.socket.onerror = errfn
    }

    if (!options.signal) {
      await Promise.race([rawSocket.connected(), errorPromise.promise])

      log('connected %s', ma)
      return rawSocket
    }

    // Allow abort via signal during connect
    let onAbort
    const abort = new Promise((resolve, reject) => {
      onAbort = () => {
        reject(new AbortError())
        // FIXME: https://github.com/libp2p/js-libp2p-websockets/issues/121
        setTimeout(() => {
          rawSocket.close()
        })
      }

      // Already aborted?
      if (options.signal.aborted) return onAbort()
      options.signal.addEventListener('abort', onAbort)
    })

    try {
      await Promise.race([abort, errorPromise.promise, rawSocket.connected()])
    } finally {
      options.signal.removeEventListener('abort', onAbort)
    }

    log('connected %s', ma)
    return rawSocket
  }

  /**
   * Creates a Websockets listener. The provided `handler` function will be called
   * anytime a new incoming Connection has been successfully upgraded via
   * `upgrader.upgradeInbound`.
   *
   * @param {object} [options]
   * @param {http.Server} [options.server] - A pre-created Node.js HTTP/S server.
   * @param {function (Connection)} handler
   * @returns {Listener} A Websockets listener
   */
  createListener (options = {}, handler) {
    if (typeof options === 'function') {
      handler = options
      options = {}
    }

    return createListener({ handler, upgrader: this._upgrader }, options)
  }

  /**
   * Takes a list of `Multiaddr`s and returns only valid Websockets addresses.
   * By default, in a browser environment only DNS+WSS multiaddr is accepted,
   * while in a Node.js environment DNS+{WS, WSS} multiaddrs are accepted.
   *
   * @param {Multiaddr[]} multiaddrs
   * @returns {Multiaddr[]} Valid Websockets multiaddrs
   */
  filter (multiaddrs) {
    multiaddrs = Array.isArray(multiaddrs) ? multiaddrs : [multiaddrs]

    if (this._filter) {
      return this._filter(multiaddrs)
    }

    // Browser
    if (env.isBrowser || env.isWebWorker) {
      return filters.dnsWss(multiaddrs)
    }

    return filters.all(multiaddrs)
  }

  /**
   * Transmits data to the server over the WebSocket connection.
   *
   * @param data a text string, ArrayBuffer or Blob to send to the server.
   */
  send (data) {
    if (this.ws) {
      if (this.debug) {
        console.debug('libp2p-websockets-curltech', 'send', this.url, data)
      }
      return this.ws.send(data)
    } else {
      throw 'INVALID_STATE_ERR : Pausing to reconnect websocket'
    }
  }

  /**
   * Closes the WebSocket connection or connection attempt, if any.
   * If the connection is already CLOSED, this method does nothing.
   */
  close (code, reason) {
    // Default CLOSE_NORMAL code
    if (typeof code == 'undefined') {
      code = 1000
    }
    this.forcedClose = true
    if (this.ws) {
      this.ws.close(code, reason)
    }
  }

  /**
   * Additional public API method to refresh the connection if still open (close, re-open).
   * For example, if the app suspects bad data / missed heart beats, it can try to refresh.
   */
  refresh () {
    if (this.ws) {
      this.ws.close()
    }
  }

  /**
   * An event listener to be called when the WebSocket connection's readyState changes to OPEN;
   * this indicates that the connection is ready to send and receive data.
   */
  onopen (event) {}
  /** An event listener to be called when the WebSocket connection's readyState changes to CLOSED. */
  onclose (event) {}
  /** An event listener to be called when a connection begins being attempted. */
  onconnecting (event) {}
  /** An event listener to be called when a message is received from the server. */
  onmessage (event) {}
  /** An event listener to be called when an error occurs. */
  onerror (event) {}
}

module.exports = withIs(WebSockets, {
  className: 'WebSockets',
  symbolName: '@libp2p/js-libp2p-websockets/websockets'
})
