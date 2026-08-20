import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
    createFtpMcpServer,
    createHostConfigurations,
    loadHostConfigurations,
    resolveLocalPath,
    resolveRemotePath
} from '../src/ftpmcp.js';

/**
 * Create isolated host configurations suitable for transport-level tests.
 */
function createTestHostConfigurations(overrides = {}, additionalHosts = []) {
    let localRoot = mkdtempSync(path.join(os.tmpdir(), 'ftpmcp-'));
    return createHostConfigurations({
        hosts: [
            {
                host: 'primary',
                hostname: 'ftp.example.com',
                protocol: 'ftps',
                username: 'user',
                password: 'secret',
                root: '/public',
                local_root: localRoot,
                ...overrides
            },
            ...additionalHosts
        ]
    });
}

/**
 * Provide only the FTP behavior exercised by a test and record every call.
 */
function createFakeClient(calls, listEntries = []) {
    return {
        ftp: { verbose: true },
        async access(options) {
            calls.push(['access', options]);
        },
        close() {
            calls.push(['close']);
        },
        async list(remotePath) {
            calls.push(['list', remotePath]);
            return listEntries;
        },
        async downloadTo(localPath, remotePath) {
            calls.push(['downloadTo', localPath, remotePath]);
            writeFileSync(localPath, 'downloaded');
        },
        async uploadFrom(localPath, remotePath) {
            calls.push(['uploadFrom', localPath, remotePath]);
        },
        async ensureDir(remotePath) {
            calls.push(['ensureDir', remotePath]);
        },
        async rename(sourcePath, destinationPath) {
            calls.push(['rename', sourcePath, destinationPath]);
        },
        async remove(remotePath) {
            calls.push(['remove', remotePath]);
        },
        async removeDir(remotePath) {
            calls.push(['removeDir', remotePath]);
        },
        async removeEmptyDir(remotePath) {
            calls.push(['removeEmptyDir', remotePath]);
        }
    };
}

/**
 * Connect an SDK client to the server without opening a network port.
 */
async function connectTestClient(hostConfigurations, calls, listEntries = []) {
    let server = createFtpMcpServer(hostConfigurations, () => createFakeClient(calls, listEntries));
    let [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let client = new Client({ name: 'ftpmcp-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
}

test('configuration validates hosts and preserves safe defaults', () => {
    let hostConfigurations = createTestHostConfigurations({ username: '', password: '' });
    let configuration = hostConfigurations.get('primary');
    assert.equal('ftps', configuration.protocol);
    assert.equal('anonymous', configuration.username);
    assert.equal('guest', configuration.password);
    assert.equal(false, configuration.readOnly);
    assert.equal(false, configuration.allowDelete);
    assert.equal(true, configuration.tlsRejectUnauthorized);
    assert.equal('', createTestHostConfigurations({ password: '' }).get('primary').password);
    assert.throws(() => createHostConfigurations({ hosts: [null] }), /Every FTP host must be an object/);
    assert.throws(
        () => createTestHostConfigurations({ password: { value: 'secret' } }),
        /FTP host primary requires password to be a string/
    );
    assert.throws(() => createTestHostConfigurations({ protocol: 'sftp' }), /FTP host primary has an invalid protocol/);
    assert.throws(() => createTestHostConfigurations({ port: '21x' }), /FTP host primary has an invalid port/);
    assert.throws(
        () =>
            createTestHostConfigurations({}, [
                {
                    host: 'primary',
                    hostname: 'duplicate.example.com',
                    local_root: configuration.localRoot
                }
            ]),
        /Duplicate FTP host: primary/
    );
});

test('configuration can be loaded from a JSON file', () => {
    let localRoot = mkdtempSync(path.join(os.tmpdir(), 'ftpmcp-'));
    let configurationFile = path.join(localRoot, 'hosts.json');
    writeFileSync(
        configurationFile,
        JSON.stringify({ hosts: [{ host: 'loaded', hostname: 'ftp.example.com', local_root: localRoot }] })
    );
    assert.equal('ftp.example.com', loadHostConfigurations(configurationFile).get('loaded').hostname);
});

test('CLI starts through the symlink created by npm', async () => {
    let localRoot = mkdtempSync(path.join(os.tmpdir(), 'ftpmcp-'));
    let configurationFile = path.join(localRoot, 'hosts.json');
    let executable = path.join(localRoot, 'ftpmcp');
    writeFileSync(
        configurationFile,
        JSON.stringify({ hosts: [{ host: 'loaded', hostname: 'ftp.example.com', local_root: localRoot }] })
    );
    symlinkSync(path.resolve('src/ftpmcp.js'), executable);

    let client = new Client({ name: 'ftpmcp-cli-test', version: '1.0.0' });
    let transport = new StdioClientTransport({
        command: executable,
        env: { ...process.env, FTP_CONFIG_FILE: configurationFile }
    });
    await client.connect(transport);
    let result = await client.listTools();
    assert.equal(
        true,
        result.tools.some(tool => tool.name === 'list_hosts')
    );
    await client.close();
});

test('remote paths cannot escape the configured root', () => {
    let configuration = createTestHostConfigurations().get('primary');
    assert.equal('/public/assets/image.png', resolveRemotePath(configuration, '/assets/image.png'));
    assert.throws(() => resolveRemotePath(configuration, '../../private'), /outside the configured root/);
});

test('local paths accept absolute shared paths and reject escapes', () => {
    let configuration = createTestHostConfigurations().get('primary');
    let localFile = path.join(configuration.localRoot, 'document.txt');
    writeFileSync(localFile, 'content');
    assert.equal(localFile, resolveLocalPath(configuration, localFile, true));
    assert.throws(() => resolveLocalPath(configuration, '../secret.txt'), /outside the configured local_root/);
});

test('local paths support a symlinked local root but cannot escape through child symlinks', () => {
    let realLocalRoot = mkdtempSync(path.join(os.tmpdir(), 'ftpmcp-real-'));
    let aliasParent = mkdtempSync(path.join(os.tmpdir(), 'ftpmcp-alias-'));
    let localRootAlias = path.join(aliasParent, 'data');
    symlinkSync(realLocalRoot, localRootAlias);
    let configuration = createTestHostConfigurations({ local_root: localRootAlias }).get('primary');
    let localFile = path.join(localRootAlias, 'document.txt');
    writeFileSync(localFile, 'content');
    assert.equal(localFile, resolveLocalPath(configuration, localFile, true));

    let externalRoot = mkdtempSync(path.join(os.tmpdir(), 'ftpmcp-external-'));
    symlinkSync(externalRoot, path.join(realLocalRoot, 'external'));
    assert.throws(() => resolveLocalPath(configuration, 'external/secret.txt'), /outside the configured local_root/);
});

test('server exposes the complete focused FTP toolset', async () => {
    let calls = [];
    let { client, server } = await connectTestClient(createTestHostConfigurations(), calls);
    let result = await client.listTools();
    assert.deepEqual(
        [
            'create_directory',
            'delete_directory',
            'delete_file',
            'download_file',
            'list_directory',
            'list_hosts',
            'rename_path',
            'test_connection',
            'upload_file'
        ],
        result.tools.map(tool => tool.name).sort()
    );
    await client.close();
    await server.close();
});

test('host listing exposes every host without credentials', async () => {
    let calls = [];
    let secondaryRoot = mkdtempSync(path.join(os.tmpdir(), 'ftpmcp-'));
    let hostConfigurations = createTestHostConfigurations({}, [
        {
            host: 'secondary',
            hostname: 'legacy.example.com',
            protocol: 'ftps-implicit',
            local_root: secondaryRoot,
            password: 'never-return-this'
        }
    ]);
    let { client, server } = await connectTestClient(hostConfigurations, calls);
    let result = await client.callTool({ name: 'list_hosts', arguments: {} });
    assert.deepEqual(
        ['primary', 'secondary'],
        result.structuredContent.hosts.map(host => host.host)
    );
    assert.equal(false, JSON.stringify(result).includes('never-return-this'));
    assert.equal(0, calls.length);
    await client.close();
    await server.close();
});

test('directory listing routes to the selected host and preserves unknown types', async () => {
    let calls = [];
    let entries = [
        {
            name: 'image.png',
            isDirectory: false,
            isSymbolicLink: false,
            isFile: false,
            size: 42,
            modifiedAt: new Date('2026-08-20T10:00:00Z')
        }
    ];
    let { client, server } = await connectTestClient(createTestHostConfigurations(), calls, entries);
    let result = await client.callTool({
        name: 'list_directory',
        arguments: { host: 'primary', path: '/assets' }
    });
    assert.equal(false, result.isError ?? false);
    assert.equal('primary', result.structuredContent.host);
    assert.equal('/assets/image.png', result.structuredContent.entries[0].path);
    assert.equal('unknown', result.structuredContent.entries[0].type);
    assert.deepEqual(
        ['list', '/public/assets'],
        calls.find(call => call[0] === 'list')
    );
    await client.close();
    await server.close();
});

test('download publishes the file only after the transfer is complete', async () => {
    let calls = [];
    let hostConfigurations = createTestHostConfigurations();
    let configuration = hostConfigurations.get('primary');
    let localFile = path.join(configuration.localRoot, 'download.txt');
    let { client, server } = await connectTestClient(hostConfigurations, calls);
    let result = await client.callTool({
        name: 'download_file',
        arguments: { host: 'primary', remote_path: '/documents/download.txt', local_path: localFile }
    });
    assert.equal(false, result.isError ?? false);
    assert.equal('downloaded', readFileSync(localFile, 'utf8'));
    assert.deepEqual(['download.txt'], readdirSync(configuration.localRoot));
    assert.notEqual(localFile, calls.find(call => call[0] === 'downloadTo')[1]);
    await client.close();
    await server.close();
});

test('upload uses local files and refuses implicit overwrites', async () => {
    let calls = [];
    let hostConfigurations = createTestHostConfigurations();
    let configuration = hostConfigurations.get('primary');
    let localFile = path.join(configuration.localRoot, 'upload.txt');
    writeFileSync(localFile, 'content');
    let entries = [{ name: 'upload.txt' }];
    let { client, server } = await connectTestClient(hostConfigurations, calls, entries);
    let result = await client.callTool({
        name: 'upload_file',
        arguments: { host: 'primary', local_path: localFile, remote_path: '/documents/upload.txt' }
    });
    assert.equal(true, result.isError);
    assert.match(result.content[0].text, /already exists/);
    assert.equal(
        undefined,
        calls.find(call => call[0] === 'uploadFrom')
    );
    await client.close();
    await server.close();
});

test('upload creates a missing remote parent before transferring', async () => {
    let calls = [];
    let hostConfigurations = createTestHostConfigurations();
    let configuration = hostConfigurations.get('primary');
    let localFile = path.join(configuration.localRoot, 'upload.txt');
    writeFileSync(localFile, 'content');
    let { client, server } = await connectTestClient(hostConfigurations, calls);
    let result = await client.callTool({
        name: 'upload_file',
        arguments: { host: 'primary', local_path: localFile, remote_path: '/new/directory/upload.txt' }
    });
    assert.equal(false, result.isError ?? false);
    assert.deepEqual(
        ['ensureDir', '/public/new/directory'],
        calls.find(call => call[0] === 'ensureDir')
    );
    assert.deepEqual(
        ['uploadFrom', localFile, '/public/new/directory/upload.txt'],
        calls.find(call => call[0] === 'uploadFrom')
    );
    await client.close();
    await server.close();
});

test('delete tools require explicit host permission', async () => {
    let calls = [];
    let { client, server } = await connectTestClient(createTestHostConfigurations(), calls);
    let result = await client.callTool({ name: 'delete_file', arguments: { host: 'primary', path: '/old.txt' } });
    assert.equal(true, result.isError);
    assert.match(result.content[0].text, /deletion is disabled/);
    assert.equal(0, calls.length);
    await client.close();
    await server.close();
});
