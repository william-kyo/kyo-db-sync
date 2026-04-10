import fs from 'fs';
import { Client, ClientChannel } from 'ssh2';
import { SSHConfig } from './config.js';

const readPrivateKey = async (filePath: string): Promise<Buffer> => {
  try {
    return await fs.promises.readFile(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    throw new Error(`无法读取 SSH 私钥 ${filePath}: ${err?.message ?? error}`);
  }
};

const waitForReady = (client: Client): Promise<void> =>
  new Promise((resolve, reject) => {
    client
      .on('ready', () => resolve())
      .on('error', (err) => reject(err));
  });

const forwardOut = (client: Client, host: string, port: number): Promise<ClientChannel> =>
  new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });

export interface Tunnel {
  stream: ClientChannel;
  close: () => Promise<void>;
}

export const createTunnel = async (
  sshConfig: SSHConfig,
  remoteHost: string,
  remotePort: number,
): Promise<Tunnel> => {
  const privateKey = await readPrivateKey(sshConfig.privateKeyPath);
  const client = new Client();
  client.connect({
    host: sshConfig.host,
    port: sshConfig.port,
    username: sshConfig.username,
    privateKey,
    passphrase: sshConfig.passphrase,
    keepaliveInterval: 20000,
    keepaliveCountMax: 3,
  });

  await waitForReady(client);
  const stream = await forwardOut(client, remoteHost, remotePort);

  const close = async (): Promise<void> =>
    new Promise((resolve) => {
      client.once('close', () => resolve());
      client.end();
    });

  return { stream, close };
};
