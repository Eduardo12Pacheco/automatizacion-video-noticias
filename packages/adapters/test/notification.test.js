import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { ConsoleNotificationAdapter, SmtpNotificationAdapter, buildSmtpMessage } from '../src/notification.js';

function startFakeSmtp() {
  const received = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 mailpit ESMTP\r\n');
    let buffer = '';
    let inData = false;
    let message = '';
    let authStep = 0;
    let awaitingAuth = false;
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (inData) {
          if (line === '.') {
            received.push(message);
            inData = false;
            message = '';
            socket.write('250 2.0.0 queued\r\n');
          } else {
            message += `${line.replace(/^\.\./, '.')}\n`;
          }
        } else if (/^EHLO/i.test(line)) {
          socket.write('250-mailpit\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
        } else if (/^AUTH LOGIN/i.test(line)) {
          authStep = 0;
          awaitingAuth = true;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (awaitingAuth && /^[A-Za-z0-9+/=]+$/.test(line)) {
          if (authStep === 0) {
            authStep = 1;
            socket.write('334 UGFzc3dvcmQ6\r\n');
          } else {
            awaitingAuth = false;
            socket.write('235 2.7.0 authenticated\r\n');
          }
        } else if (/^MAIL FROM/i.test(line)) {
          socket.write('250 2.1.0 ok\r\n');
        } else if (/^RCPT TO/i.test(line)) {
          socket.write('250 2.1.5 ok\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
        index = buffer.indexOf('\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      received,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

test('buildSmtpMessage encodes non-ASCII subjects and base64 bodies', () => {
  const message = buildSmtpMessage({ from: 'news@example.local', to: 'a@example.local', subject: 'Publicación lista', text: 'Hola' });
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  assert.match(message, /Content-Transfer-Encoding: base64/);
});

test('SmtpNotificationAdapter speaks enough SMTP for Mailpit with auth', async () => {
  const fake = await startFakeSmtp();
  try {
    const adapter = new SmtpNotificationAdapter({
      host: '127.0.0.1',
      port: fake.port,
      user: 'demo',
      pass: 'not-a-real-password',
      from: 'newsroom@example.local',
    });

    const result = await adapter.send({ to: 'editor@example.local', subject: 'Guion listo', text: 'El guion está listo.' });

    assert.equal(result.status, 'sent');
    assert.equal(fake.received.length, 1);
    assert.match(fake.received[0], /To: editor@example\.local/);
    const body = fake.received[0].split('\n\n').pop().replace(/\s+/g, '');
    assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'El guion está listo.');
  } finally {
    await fake.close();
  }
});

test('ConsoleNotificationAdapter logs a redacted line and does not require SMTP', async () => {
  const lines = [];
  const adapter = new ConsoleNotificationAdapter({ logger: { info: (line) => lines.push(line), debug: () => {} } });

  const result = await adapter.send({ to: 'editor@example.local', subject: 'Listo', text: 'contenido' });

  assert.equal(result.adapter, 'console');
  assert.match(lines[0], /editor@example\.local/);
  assert.match(lines[0], /Listo/);
});
