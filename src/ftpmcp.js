#!/usr/bin/env node
import { Client as FtpClient } from 'basic-ftp';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path, { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

let PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * Read a strict boolean without silently enabling sensitive operations.
 */
function readBoolean(value, fallback) {
    if (value === undefined || value === '') {
        return fallback;
    }
    if (value === true || value === 'true' || value === '1') {
        return true;
    }
    if (value === false || value === 'false' || value === '0') {
        return false;
    }
    throw new Error(`Invalid boolean value: ${String(value)}`);
}

/**
 * Build validated runtime configurations without exposing credentials.
 */
export function createHostConfigurations(data) {
    if (!data || !Array.isArray(data.hosts) || data.hosts.length === 0) {
        throw new Error('FTP configuration must contain at least one host.');
    }

    let hostConfigurations = new Map();
    for (let hostData of data.hosts) {
        if (!hostData || typeof hostData !== 'object' || Array.isArray(hostData)) {
            throw new Error('Every FTP host must be an object.');
        }
        let host = String(hostData.host ?? '').trim();
        let hostname = String(hostData.hostname ?? '').trim();
        if (host === '' || hostname === '') {
            throw new Error('Every FTP host requires non-empty host and hostname values.');
        }
        if (hostConfigurations.has(host)) {
            throw new Error(`Duplicate FTP host: ${host}`);
        }
        for (let field of ['username', 'password', 'root', 'local_root']) {
            if (hostData[field] !== undefined && typeof hostData[field] !== 'string') {
                throw new Error(`FTP host ${host} requires ${field} to be a string.`);
            }
        }

        let protocol = String(hostData.protocol ?? 'ftps')
            .trim()
            .toLowerCase();
        if (!['ftp', 'ftps', 'ftps-implicit'].includes(protocol)) {
            throw new Error(`FTP host ${host} has an invalid protocol.`);
        }
        let defaultPort = protocol === 'ftps-implicit' ? 990 : 21;
        let port = Number(hostData.port ?? defaultPort);
        let timeout = Number(hostData.timeout ?? 30000);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`FTP host ${host} has an invalid port.`);
        }
        if (!Number.isInteger(timeout) || timeout < 1) {
            throw new Error(`FTP host ${host} has an invalid timeout.`);
        }

        let localRoot = path.resolve(String(hostData.local_root ?? '/host/data'));
        if (!existsSync(localRoot) || !statSync(localRoot).isDirectory()) {
            throw new Error(`FTP host ${host} has no existing local root: ${localRoot}`);
        }
        let username = String(hostData.username ?? '').trim();
        let password = String(hostData.password ?? '');
        if (username === '' && password === '') {
            password = 'guest';
        }
        hostConfigurations.set(
            host,
            Object.freeze({
                host,
                hostname,
                protocol,
                port,
                username: username === '' ? 'anonymous' : username,
                password,
                remoteRoot: posix.resolve('/', String(hostData.root ?? '/')),
                localRoot,
                localRootReal: realpathSync(localRoot),
                readOnly: readBoolean(hostData.read_only, false),
                allowDelete: readBoolean(hostData.allow_delete, false),
                tlsRejectUnauthorized: readBoolean(hostData.tls_reject_unauthorized, true),
                timeout
            })
        );
    }
    return hostConfigurations;
}

/**
 * Load the host list from the file provided to the MCP process.
 */
export function loadHostConfigurations(configurationFile = process.env.FTP_CONFIG_FILE) {
    let filePath = String(configurationFile ?? '').trim();
    if (filePath === '') {
        throw new Error('FTP_CONFIG_FILE is required.');
    }
    return createHostConfigurations(JSON.parse(readFileSync(filePath, 'utf8')));
}

/**
 * Resolve a model-supplied path relative to the configured remote root.
 */
export function resolveRemotePath(configuration, suppliedPath = '/') {
    let input = String(suppliedPath).trim();
    if (input.includes('\0')) {
        throw new Error('Remote path contains an invalid null byte.');
    }
    let resolvedPath = posix.resolve(configuration.remoteRoot, input.replace(/^\/+/, '') || '.');
    if (resolvedPath !== configuration.remoteRoot && !resolvedPath.startsWith(`${configuration.remoteRoot}/`)) {
        throw new Error('Remote path is outside the configured root.');
    }
    return resolvedPath;
}

/**
 * Resolve a model-supplied path while guarding against local symlink escapes.
 */
export function resolveLocalPath(configuration, suppliedPath, requireExisting = false) {
    let input = String(suppliedPath).trim();
    if (input === '' || input.includes('\0')) {
        throw new Error('Local path is empty or invalid.');
    }

    let candidatePath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(configuration.localRoot, input);
    if (
        candidatePath !== configuration.localRoot &&
        !candidatePath.startsWith(`${configuration.localRoot}${path.sep}`)
    ) {
        throw new Error('Local path is outside the configured local_root.');
    }
    if (requireExisting && !existsSync(candidatePath)) {
        throw new Error(`Local path does not exist: ${candidatePath}`);
    }

    let existingPath = candidatePath;
    while (!existsSync(existingPath)) {
        let parentPath = path.dirname(existingPath);
        if (parentPath === existingPath) {
            throw new Error('Local path has no existing parent directory.');
        }
        existingPath = parentPath;
    }
    let realExistingPath = realpathSync(existingPath);
    if (
        realExistingPath !== configuration.localRootReal &&
        !realExistingPath.startsWith(`${configuration.localRootReal}${path.sep}`)
    ) {
        throw new Error('Local path resolves outside the configured local_root.');
    }
    return candidatePath;
}

/**
 * Convert an internal remote path back to the host-relative form exposed by tools.
 */
function displayRemotePath(configuration, remotePath) {
    let relativePath = posix.relative(configuration.remoteRoot, remotePath);
    return relativePath === '' ? '/' : `/${relativePath}`;
}

/**
 * Return MCP content and structured output from one canonical payload.
 */
function toolResult(payload) {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload
    };
}

/**
 * Convert operational failures into structured MCP errors without leaking credentials.
 */
function toolError(error) {
    let message = error instanceof Error ? error.message : String(error);
    return {
        isError: true,
        content: [{ type: 'text', text: message }],
        structuredContent: { success: false, error: message }
    };
}

/**
 * Open one short-lived FTP connection so failed calls cannot poison later operations.
 */
async function executeWithClient(configuration, clientFactory, operation) {
    let client = clientFactory(configuration.timeout);
    try {
        client.ftp.verbose = false;
        await client.access({
            host: configuration.hostname,
            port: configuration.port,
            user: configuration.username,
            password: configuration.password,
            secure: configuration.protocol === 'ftps-implicit' ? 'implicit' : configuration.protocol === 'ftps',
            secureOptions:
                configuration.protocol === 'ftp'
                    ? undefined
                    : { rejectUnauthorized: configuration.tlsRejectUnauthorized }
        });
        return toolResult(await operation(client));
    } catch (error) {
        return toolError(error);
    } finally {
        client.close();
    }
}

/**
 * Check a target through its parent listing to preserve the default no-overwrite policy.
 */
async function remotePathExists(client, remotePath) {
    let parentPath = posix.dirname(remotePath);
    let targetName = posix.basename(remotePath);
    let entries = await client.list(parentPath);
    return entries.some(entry => entry.name === targetName);
}

/**
 * Resolve a configured host before any network or filesystem operation starts.
 */
function getHostConfiguration(hostConfigurations, host) {
    let configuration = hostConfigurations.get(host);
    if (!configuration) {
        throw new Error(`Unknown FTP host: ${host}`);
    }
    return configuration;
}

/**
 * Create one MCP server that routes operations to any configured FTP host.
 */
export function createFtpMcpServer(hostConfigurations, clientFactory = timeout => new FtpClient(timeout)) {
    if (!(hostConfigurations instanceof Map) || hostConfigurations.size === 0) {
        throw new Error('At least one FTP host is required to create the MCP server.');
    }
    let server = new McpServer({ name: 'ftpmcp', version: PACKAGE_VERSION });
    let hostSchema = z.enum([...hostConfigurations.keys()]).describe('Configured FTP host alias.');

    server.registerTool(
        'list_hosts',
        {
            title: 'List FTP Hosts',
            description: 'List every configured FTP host without exposing credentials.',
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
        },
        async () =>
            toolResult({
                success: true,
                hosts: [...hostConfigurations.values()].map(configuration => ({
                    host: configuration.host,
                    hostname: configuration.hostname,
                    protocol: configuration.protocol,
                    port: configuration.port,
                    remote_root: '/',
                    read_only: configuration.readOnly,
                    allow_delete: configuration.allowDelete
                }))
            })
    );

    server.registerTool(
        'test_connection',
        {
            title: 'Test FTP Connection',
            description: 'Connect to a configured FTP host and verify authentication.',
            inputSchema: {
                host: hostSchema
            },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
        },
        async ({ host }) => {
            let configuration = getHostConfiguration(hostConfigurations, host);
            return executeWithClient(configuration, clientFactory, async client => {
                await client.list(configuration.remoteRoot);
                return {
                    success: true,
                    host: configuration.host,
                    protocol: configuration.protocol,
                    hostname: configuration.hostname,
                    remote_root: '/'
                };
            });
        }
    );

    server.registerTool(
        'list_directory',
        {
            title: 'List FTP Directory',
            description: 'List files and directories below the configured remote root.',
            inputSchema: {
                host: hostSchema,
                path: z.string().default('/').describe('Remote path relative to the configured FTP root.')
            },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
        },
        async ({ host, path: remotePathInput }) => {
            let configuration = getHostConfiguration(hostConfigurations, host);
            let remotePath;
            try {
                remotePath = resolveRemotePath(configuration, remotePathInput);
            } catch (error) {
                return toolError(error);
            }
            return executeWithClient(configuration, clientFactory, async client => {
                let entries = await client.list(remotePath);
                return {
                    success: true,
                    host: configuration.host,
                    path: displayRemotePath(configuration, remotePath),
                    entries: entries.map(entry => {
                        let type = 'unknown';
                        if (entry.isFile) {
                            type = 'file';
                        }
                        if (entry.isSymbolicLink) {
                            type = 'symlink';
                        }
                        if (entry.isDirectory) {
                            type = 'directory';
                        }
                        return {
                            name: entry.name,
                            path: displayRemotePath(configuration, posix.join(remotePath, entry.name)),
                            type,
                            size: entry.size,
                            modified_at: entry.modifiedAt?.toISOString() ?? null
                        };
                    })
                };
            });
        }
    );

    server.registerTool(
        'download_file',
        {
            title: 'Download FTP File',
            description: 'Download a remote file into the configured local root.',
            inputSchema: {
                host: hostSchema,
                remote_path: z.string().min(1).describe('Remote file path relative to the configured FTP root.'),
                local_path: z.string().min(1).describe('Local destination path below the host local_root.'),
                overwrite: z.boolean().default(false).describe('Replace an existing local file.')
            },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        async ({ host, remote_path: remotePathInput, local_path: localPathInput, overwrite }) => {
            let configuration = getHostConfiguration(hostConfigurations, host);
            let remotePath;
            let localPath;
            try {
                remotePath = resolveRemotePath(configuration, remotePathInput);
                localPath = resolveLocalPath(configuration, localPathInput);
                if (existsSync(localPath) && !overwrite) {
                    throw new Error(`Local destination already exists: ${localPath}`);
                }
                mkdirSync(path.dirname(localPath), { recursive: true });
                resolveLocalPath(configuration, path.dirname(localPath), true);
            } catch (error) {
                return toolError(error);
            }
            return executeWithClient(configuration, clientFactory, async client => {
                let temporaryPath = path.join(
                    path.dirname(localPath),
                    `.${path.basename(localPath)}.${randomUUID()}.tmp`
                );
                try {
                    await client.downloadTo(temporaryPath, remotePath);
                    if (existsSync(localPath) && !overwrite) {
                        throw new Error(`Local destination already exists: ${localPath}`);
                    }
                    renameSync(temporaryPath, localPath);
                    return {
                        success: true,
                        host: configuration.host,
                        remote_path: displayRemotePath(configuration, remotePath),
                        local_path: localPath,
                        size: statSync(localPath).size
                    };
                } finally {
                    if (existsSync(temporaryPath)) {
                        unlinkSync(temporaryPath);
                    }
                }
            });
        }
    );

    server.registerTool(
        'upload_file',
        {
            title: 'Upload FTP File',
            description: 'Upload a local file to the configured remote root.',
            inputSchema: {
                host: hostSchema,
                local_path: z.string().min(1).describe('Existing local file below the host local_root.'),
                remote_path: z.string().min(1).describe('Remote destination relative to the configured FTP root.'),
                overwrite: z.boolean().default(false).describe('Replace an existing remote file.')
            },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        async ({ host, local_path: localPathInput, remote_path: remotePathInput, overwrite }) => {
            let configuration = getHostConfiguration(hostConfigurations, host);
            if (configuration.readOnly) {
                return toolError(new Error('FTP host is read-only.'));
            }
            let localPath;
            let remotePath;
            try {
                localPath = resolveLocalPath(configuration, localPathInput, true);
                if (!statSync(localPath).isFile()) {
                    throw new Error(`Local source is not a file: ${localPath}`);
                }
                remotePath = resolveRemotePath(configuration, remotePathInput);
                if (remotePath === configuration.remoteRoot) {
                    throw new Error('Remote destination must include a file name.');
                }
            } catch (error) {
                return toolError(error);
            }
            return executeWithClient(configuration, clientFactory, async client => {
                await client.ensureDir(posix.dirname(remotePath));
                if (!overwrite && (await remotePathExists(client, remotePath))) {
                    throw new Error(
                        `Remote destination already exists: ${displayRemotePath(configuration, remotePath)}`
                    );
                }
                await client.uploadFrom(localPath, remotePath);
                return {
                    success: true,
                    host: configuration.host,
                    local_path: localPath,
                    remote_path: displayRemotePath(configuration, remotePath),
                    size: statSync(localPath).size
                };
            });
        }
    );

    server.registerTool(
        'create_directory',
        {
            title: 'Create FTP Directory',
            description: 'Create a directory below the configured remote root.',
            inputSchema: {
                host: hostSchema,
                path: z.string().min(1).describe('Remote directory relative to the configured FTP root.')
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true
            }
        },
        async ({ host, path: remotePathInput }) => {
            let configuration = getHostConfiguration(hostConfigurations, host);
            if (configuration.readOnly) {
                return toolError(new Error('FTP host is read-only.'));
            }
            let remotePath;
            try {
                remotePath = resolveRemotePath(configuration, remotePathInput);
            } catch (error) {
                return toolError(error);
            }
            return executeWithClient(configuration, clientFactory, async client => {
                await client.ensureDir(remotePath);
                return { success: true, host: configuration.host, path: displayRemotePath(configuration, remotePath) };
            });
        }
    );

    server.registerTool(
        'rename_path',
        {
            title: 'Rename FTP Path',
            description: 'Rename or move a remote file or directory without overwriting a destination.',
            inputSchema: {
                host: hostSchema,
                source_path: z.string().min(1).describe('Existing remote source relative to the configured FTP root.'),
                destination_path: z.string().min(1).describe('New remote path relative to the configured FTP root.')
            },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        async ({ host, source_path: sourcePathInput, destination_path: destinationPathInput }) => {
            let configuration = getHostConfiguration(hostConfigurations, host);
            if (configuration.readOnly) {
                return toolError(new Error('FTP host is read-only.'));
            }
            let sourcePath;
            let destinationPath;
            try {
                sourcePath = resolveRemotePath(configuration, sourcePathInput);
                destinationPath = resolveRemotePath(configuration, destinationPathInput);
                if (sourcePath === configuration.remoteRoot || destinationPath === configuration.remoteRoot) {
                    throw new Error('The configured FTP root cannot be renamed or replaced.');
                }
            } catch (error) {
                return toolError(error);
            }
            return executeWithClient(configuration, clientFactory, async client => {
                if (await remotePathExists(client, destinationPath)) {
                    throw new Error(
                        `Remote destination already exists: ${displayRemotePath(configuration, destinationPath)}`
                    );
                }
                await client.rename(sourcePath, destinationPath);
                return {
                    success: true,
                    host: configuration.host,
                    source_path: displayRemotePath(configuration, sourcePath),
                    destination_path: displayRemotePath(configuration, destinationPath)
                };
            });
        }
    );

    server.registerTool(
        'delete_file',
        {
            title: 'Delete FTP File',
            description: 'Delete one remote file when deletion is enabled for the host.',
            inputSchema: {
                host: hostSchema,
                path: z.string().min(1).describe('Remote file relative to the configured FTP root.')
            },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        async ({ host, path: remotePathInput }) => {
            let configuration = getHostConfiguration(hostConfigurations, host);
            if (configuration.readOnly || !configuration.allowDelete) {
                return toolError(new Error('FTP deletion is disabled for this host.'));
            }
            let remotePath;
            try {
                remotePath = resolveRemotePath(configuration, remotePathInput);
                if (remotePath === configuration.remoteRoot) {
                    throw new Error('The configured FTP root cannot be deleted.');
                }
            } catch (error) {
                return toolError(error);
            }
            return executeWithClient(configuration, clientFactory, async client => {
                await client.remove(remotePath);
                return { success: true, host: configuration.host, path: displayRemotePath(configuration, remotePath) };
            });
        }
    );

    server.registerTool(
        'delete_directory',
        {
            title: 'Delete FTP Directory',
            description: 'Delete an empty or explicitly recursive remote directory when deletion is enabled.',
            inputSchema: {
                host: hostSchema,
                path: z.string().min(1).describe('Remote directory relative to the configured FTP root.'),
                recursive: z.boolean().default(false).describe('Also delete all contents below the directory.')
            },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
        },
        async ({ host, path: remotePathInput, recursive }) => {
            let configuration = getHostConfiguration(hostConfigurations, host);
            if (configuration.readOnly || !configuration.allowDelete) {
                return toolError(new Error('FTP deletion is disabled for this host.'));
            }
            let remotePath;
            try {
                remotePath = resolveRemotePath(configuration, remotePathInput);
                if (remotePath === configuration.remoteRoot) {
                    throw new Error('The configured FTP root cannot be deleted.');
                }
            } catch (error) {
                return toolError(error);
            }
            return executeWithClient(configuration, clientFactory, async client => {
                if (recursive) {
                    await client.removeDir(remotePath);
                }
                if (!recursive) {
                    await client.removeEmptyDir(remotePath);
                }
                return {
                    success: true,
                    host: configuration.host,
                    path: displayRemotePath(configuration, remotePath),
                    recursive
                };
            });
        }
    );

    return server;
}

/**
 * Start the stdio transport used by MCP clients.
 */
export async function start() {
    let hostConfigurations = loadHostConfigurations();
    let server = createFtpMcpServer(hostConfigurations);
    await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    start().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
