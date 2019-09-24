const WebSocket = require('ws');
const EventEmitter = require('events');
const crypto = require('crypto');

const wait = n => new Promise(r => setTimeout(r, n));

const PONG = '{"type": "pong"}';

const STALE_TIMEOUT = 2000;

// this endpoint is used by the sample code on
// https://github.com/ftexchange/ftx/blob/d387304bcc6f479e0ecae8273ad84eda986f5237/websocket/client.py#L13
const DEFAULT_ENDPOINT = 'ftx.com/ws/';

// pass optional params: { key, secret, subaccount, endpoint }
class Connection extends EventEmitter {
  constructor(conf = {}) {
    super();

    this.key = conf.key;
    this.secret = conf.secret;
    this.subaccount = conf.subaccount;
    this.WSendpoint = conf.endpoint || DEFAULT_ENDPOINT;

    this.connected = false;
    this.isReadyHook = false;
    this.isReady = new Promise((r => this.isReadyHook = r));
    this.authenticated = false;
    this.reconnecting = false;
    this.afterReconnect;

    this.subscriptions = [];

    this.lastMessageAt = 0;
  }

  _connect() {
    if(this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`wss://${this.WSendpoint}`);
      this.ws.onmessage = this.handleWSMessage;

      this.ws.onopen = () => {
        this.connected = true;

        this.isReadyHook();
        resolve();
      }

      this.ws.onerror = e => {
        console.log(new Date, '[FTX] WS ERROR', e.message);
      }

      this.ws.onclose = async e => {
        console.log(new Date, '[FTX] CLOSED CON');
        this.authenticated = false;
        this.connected = false;

        clearInterval(this.heartbeat);

        this.reconnect();
      }

      this.heartbeat = setInterval(this.ping, 5 * 1000);
    });
  }

  terminate = async() => {
    console.log(new Date, '[FTX] TERMINATED WS CON');
    this.ws.terminate();
    this.authenticated = false;
    this.connected = false;
  }

  reconnect = async () => {
    this.reconnecting = true;
    this.pingAt = false;
    this.pongAt = false;

    let hook;
    this.afterReconnect = new Promise(r => hook = r);
    this.isReady = new Promise((r => this.isReadyHook = r));
    await wait(500);
    console.log(new Date, '[FTX] RECONNECTING...');
    await this.connect();
    hook();
    this.isReadyHook();

    this.subscriptions.forEach(sub => {
      this._subscribe(sub);
    });
  }

  connect = async () => {
    await this._connect();
    if(this.key) {
      this.authenticate();
    }
  }

  // not a proper op, but forces a response so
  // we know the connection isn't stale
  ping = () => {
    if(this.pingAt && this.pongAt > this.pingAt && this.pongAt - this.pingAt > STALE_TIMEOUT) {
      console.error(new Date, '[FTX] did NOT receive pong in time, reconnecting', {
        pingAt: this.pingAt,
        pongAt: this.pongAt
      });
      return this.terminate();
    }

    this.pingAt = +new Date;
    this.sendMessage({op: 'ping'});
  }

  // note: when this method returns
  // we do not know what auth status is
  // since FTX doesn't ACK
  authenticate = async () => {
    if(!this.connected) {
      await this.connect();
    }

    const date = +new Date;
    const signature = crypto.createHmac('sha256', this.secret)
      .update(date + 'websocket_login').digest('hex');

    const message = {
      op: 'login',
      args: {
        key: this.key,
        sign: signature,
        time: date,
        subaccount: this.subaccount
      }
    }

    this.sendMessage(message);

    this.authenticated = true;
  }

  handleWSMessage = e => {
    this.lastMessageAt = +new Date;
    let payload;

    if(e.data === PONG && this.lastMessageAt - this.pingAt < 5000) {
      this.pongAt = this.lastMessageAt;
      return;
    }

    try {
      payload = JSON.parse(e.data);
    } catch(e) {
      console.error('ftx send bad json', e.data);
    }

    if(payload.type === 'subscribed') {
      this.subscriptions.forEach(sub => {
        if(sub.market === payload.market && sub.channel === payload.channel) {
          sub.doneHook();
        }
      });
    }

    else if(payload.type === 'update' || payload.type === 'partial') {
      const id = this.toId(payload.market, payload.channel);
      this.emit(id, payload.data);
    }

    else {
      console.log(new Date, '[FTX] unhandled WS event', payload);
    }
  }

  toId(market, channel) {
    if(!market) {
      return channel;
    }

    return market + '::' + channel;
  }

  sendMessage = async (payload) => {
    if(!this.connected) {
      if(!this.reconnecting) {
        throw new Error('Not connected.')
      }

      await this.afterReconnect;
    }

    this.ws.send(JSON.stringify(payload));
  }

  subscribe = async (channel, market = undefined) => {

    const id = this.toId(market, channel);

    if(!this.connected) {
      if(!this.reconnecting) {
        throw new Error('Not connected.')
      }

      await this.afterReconnect;
    }

    if(this.subscriptions.map(s => s.id).includes(id)) {
      return console.error(new Date, 'refusing to channel subscribe twice', market, channel);
    }

    const sub = {
      id,
      channel,
      market,
      doneHook: false,
      done: false
    }

    this.subscriptions.push(sub);
    this._subscribe(sub);

    return sub.done;
  }

  _subscribe(sub) {

    sub.done = new Promise(r => sub.doneHook = r);

    const message = {
      op: 'subscribe',
      market: sub.market,
      channel: sub.channel
    }

    this.sendMessage(message);
  }
}


module.exports = Connection;