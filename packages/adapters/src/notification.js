import net from 'node:net';
import tls from 'node:tls';

import { AdapterError } from './http.js';

function encodeHeader(value) {
  const text = String(value || '');
  // RFC 2047 for non-ASCII subjects, plain otherwise.
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

export function buildSmtpMessage({ from = 'newsroom@example.local', to = '', subject = '', text = '' } = {}) {
  const recipients = Array.isArray(to) ? to.join(', ') : String(to || '');
  const body = Buffer.from(String(text || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${from}`,
    `To: ${recipients}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

export class ConsoleNotificationAdapter {
  constructor({ logger = console } = {}) {
    this.logger = logger;
  }

  async send({ to = '', subject = '', text = '' } = {}) {
    const recipient = Array.isArray(to) ? to.join(', ') : String(to || '');
    this.logger.info?.(`[notification] to=${recipient || 'unset'} subject=${String(subject || '').slice(0, 200)}`);
    this.logger.debug?.(text);
    return { status: 'sent', adapter: 'console' };
  }
}

/**
 * Small dependency-free SMTP client. It covers the local Mailpit path (plain
 * SMTP, no auth) and the documented Gmail app-password path (STARTTLS + AUTH
 * LOGIN) without pulling a mail library into the API.
 */
export class SmtpNotificationAdapter {
  constructor({
    host = '127.0.0.1',
    port = 1025,
    secure = false,
    starttls = false,
    user = '',
    pass = '',
    from = 'newsroom@example.local',
    hostname = 'localhost',
    timeoutMs = 15_000,
    connectImpl = net.connect,
    tlsConnectImpl = tls.connect,
  } = {}) {
    this.host = host;
    this.port = Number(port) || 1025;
    this.secure = Boolean(secure);
    this.starttls = Boolean(starttls);
    this.user = String(user || '');
    this.pass = String(pass || '');
    this.from = String(from || 'newsroom@example.local');
    this.hostname = String(hostname || 'localhost');
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 15_000);
    this.connectImpl = connectImpl;
    this.tlsConnectImpl = tlsConnectImpl;
  }

  async send({ to = '', subject = '', text = '' } = {}) {
    const recipients = (Array.isArray(to) ? to : [to]).map((value) => String(value || '').trim()).filter(Boolean);
    if (!recipients.length) throw new AdapterError('notification_recipient_missing', 'At least one recipient is required', { statusCode: 400 });
    if (recipients.some((value) => !/^[^@\s]+@[^@\s]+$/.test(value))) {
      throw new AdapterError('notification_recipient_invalid', 'Recipient email is invalid', { statusCode: 400 });
    }
    const message = buildSmtpMessage({ from: this.from, to: recipients, subject, text });
    await this._deliver({ recipients, message });
    return { status: 'sent', adapter: 'smtp' };
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const options = this.secure
        ? { host: this.host, port: this.port, servername: this.host }
        : { host: this.host, port: this.port };
      const onConnect = () => {
        socket.pause?.();
        resolve(socket);
      };
      const socket = this.secure
        ? this.tlsConnectImpl(options, onConnect)
        : this.connectImpl(options, onConnect);
      socket.setTimeout?.(this.timeoutMs, () => {
        socket.destroy?.();
        reject(new AdapterError('smtp_timeout', `SMTP connection timed out after ${this.timeoutMs} ms`));
      });
      socket.once('error', (error) => reject(new AdapterError('smtp_unreachable', String(error?.message || error), { cause: error })));
    });
  }

  async verify() {
    let socket = await this._connect();
    let buffer = '';
    const replies = [];
    const waiters = [];
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const match = line.match(/^(\d{3})([ -])(.*)$/);
        if (match) {
          if (!pending) pending = { code: Number(match[1]), lines: [] };
          pending.lines.push(match[3]);
          if (match[2] === ' ') {
            const reply = { code: pending.code, text: pending.lines.join('\n') };
            pending = null;
            const waiter = waiters.shift();
            if (waiter) waiter.resolve(reply);
            else replies.push(reply);
          }
        }
        newline = buffer.indexOf('\n');
      }
    };
    let pending = null;
    socket.on('data', onData);
    socket.resume?.();
    const readReply = () => {
      const queued = replies.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push({ resolve }));
    };
    try {
      const greeting = await readReply();
      if (greeting.code !== 220) throw new AdapterError('smtp_command_failed', `SMTP greeting failed (SMTP ${greeting.code})`);
      socket.write(`EHLO ${this.hostname}\r\n`);
      const ehlo = await readReply();
      if (ehlo.code !== 250) throw new AdapterError('smtp_command_failed', `SMTP EHLO failed (SMTP ${ehlo.code})`);
      socket.write('QUIT\r\n');
      await readReply().catch(() => null);
      return { ok: true, adapter: 'smtp', host: this.host, port: this.port };
    } finally {
      socket.removeListener?.('data', onData);
      socket.end?.();
    }
  }

  async _deliver({ recipients, message }) {
    let socket = await this._connect();
    let buffer = '';
    let pending = null;
    let commandChain = Promise.resolve();
    const replies = [];
    const waiters = [];
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const match = line.match(/^(\d{3})([ -])(.*)$/);
        if (match) {
          if (!pending) pending = { code: Number(match[1]), lines: [] };
          pending.lines.push(match[3]);
          if (match[2] === ' ') {
            const reply = { code: pending.code, text: pending.lines.join('\n') };
            pending = null;
            const waiter = waiters.shift();
            if (waiter) waiter.resolve(reply);
            else replies.push(reply);
          }
        }
        newline = buffer.indexOf('\n');
      }
    };
    socket.on('data', onData);
    socket.resume?.();

    const readReply = () => {
      const queued = replies.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    };
    const send = (line) => {
      commandChain = commandChain.then(() => new Promise((resolve, reject) => {
        socket.write(`${line}\r\n`, (error) => (error ? reject(error) : resolve()));
      }));
      return commandChain;
    };
    const expect = async (allowed, label) => {
      const reply = await readReply();
      if (!allowed.includes(reply.code)) {
        throw new AdapterError('smtp_command_failed', `${label} failed (SMTP ${reply.code}): ${reply.text}`);
      }
      return reply;
    };

    try {
      await expect([220], 'greeting');
      await send(`EHLO ${this.hostname}`);
      let ehlo = await expect([250], 'EHLO');
      if (this.starttls) {
        await send('STARTTLS');
        await expect([220], 'STARTTLS');
        socket.removeListener('data', onData);
        const upgraded = await new Promise((resolve, reject) => {
          const secureSocket = this.tlsConnectImpl({ socket, servername: this.host }, () => {
            secureSocket.pause?.();
            resolve(secureSocket);
          });
          secureSocket.once('error', (error) => reject(new AdapterError('smtp_tls_failed', String(error?.message || error), { cause: error })));
        });
        socket = secureSocket;
        buffer = '';
        socket.on('data', onData);
        socket.resume?.();
        await send(`EHLO ${this.hostname}`);
        ehlo = await expect([250], 'EHLO after STARTTLS');
      }
      if (this.user) {
        const capabilities = String(ehlo.text || '').toUpperCase();
        if (!capabilities.includes('AUTH')) {
          throw new AdapterError('smtp_auth_unsupported', 'SMTP server did not advertise AUTH');
        }
        await send('AUTH LOGIN');
        await expect([334], 'AUTH LOGIN');
        await send(Buffer.from(this.user, 'utf8').toString('base64'));
        await expect([334], 'SMTP username');
        await send(Buffer.from(this.pass, 'utf8').toString('base64'));
        await expect([235], 'SMTP authentication');
      }
      await send(`MAIL FROM:<${this.from}>`);
      await expect([250], 'MAIL FROM');
      for (const recipient of recipients) {
        await send(`RCPT TO:<${recipient}>`);
        await expect([250, 251], 'RCPT TO');
      }
      await send('DATA');
      await expect([354], 'DATA');
      const stuffed = String(message || '').replace(/\r?\n/g, '\r\n').replace(/\r\n\./g, '\r\n..');
      await send(`${stuffed}\r\n.`);
      await expect([250], 'message body');
      await send('QUIT');
      await expect([221], 'QUIT').catch(() => null);
      return { status: 'sent' };
    } finally {
      socket.removeListener?.('data', onData);
      socket.end?.();
    }
  }
}
