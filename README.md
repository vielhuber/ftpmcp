[![build status](https://github.com/vielhuber/ftpmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vielhuber/ftpmcp/actions)
[![GitHub Tag](https://img.shields.io/github/v/tag/vielhuber/ftpmcp)](https://github.com/vielhuber/ftpmcp/tags)
[![License](https://img.shields.io/github/license/vielhuber/ftpmcp)](https://github.com/vielhuber/ftpmcp/blob/main/LICENSE.md)
[![Last Commit](https://img.shields.io/github/last-commit/vielhuber/ftpmcp)](https://github.com/vielhuber/ftpmcp/commits)
[![node version](https://img.shields.io/node/v/@vielhuber/ftpmcp)](https://www.npmjs.com/package/@vielhuber/ftpmcp)
[![npm Version](https://img.shields.io/npm/v/@vielhuber/ftpmcp)](https://www.npmjs.com/package/@vielhuber/ftpmcp)
[![npm Downloads](https://img.shields.io/npm/dt/@vielhuber/ftpmcp)](https://www.npmjs.com/package/@vielhuber/ftpmcp)

# 🗃️ftpmcp🗃️

A focused [Model Context Protocol](https://modelcontextprotocol.io/) server for FTP and FTPS file operations.
It deliberately does not implement SFTP: SSH-based transfers belong in an SSH MCP instead of duplicating credentials and transport logic here.

## Features

- Plain FTP, explicit FTPS and implicit FTPS
- Any number of named FTP hosts in one MCP process
- Remote operations restricted to each host's `root`
- Local uploads and downloads restricted to each host's `local_root`, including symlink checks
- Read-only mode and separately guarded deletion
- Structured MCP results and errors
- No credential values in tool responses

## Installation

```bash
npm install -g @vielhuber/ftpmcp
```

## Configuration

```json
{
    "hosts": [
        {
            "host": "website",
            "hostname": "ftp.example.com",
            "protocol": "ftps",
            "port": 21,
            "username": "user",
            "password": "your_password",
            "root": "/public_html",
            "local_root": "/host/data",
            "read_only": false,
            "allow_delete": false,
            "tls_reject_unauthorized": true,
            "timeout": 30000
        }
    ]
}
```

Pass the file to the server:

```bash
export FTP_CONFIG_FILE=/path/to/ftp-hosts.json
```

`protocol` accepts `ftp`, `ftps` and `ftps-implicit`. Prefer FTPS whenever the server supports it. Plain FTP sends credentials and content without transport encryption.

`root` is the visible remote root for every tool path on that host. Configure the FTP account itself with an equivalent server-side chroot: FTP cannot reliably prevent a server-provided symbolic link from pointing outside a merely client-side path boundary.

`local_root` restricts local uploads and downloads. Both relative paths and absolute paths below that directory are accepted.

`read_only: true` blocks uploads, directory creation, renames and deletion. Deletion additionally requires `allow_delete: true`.

Every operation except `list_hosts` requires the selected `host` alias.

## MCP client

```json
{
    "mcpServers": {
        "ftp": {
            "command": "ftpmcp",
            "env": {
                "FTP_CONFIG_FILE": "/path/to/ftp-hosts.json"
            }
        }
    }
}
```

## Tools

| Tool               | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `list_hosts`       | List every configured host without credentials                             |
| `test_connection`  | Verify the configured connection and login                                 |
| `list_directory`   | List one remote directory                                                  |
| `download_file`    | Download a remote file below the selected host's `local_root`              |
| `upload_file`      | Upload a local file without overwriting by default                         |
| `create_directory` | Create a remote directory                                                  |
| `rename_path`      | Rename or move a remote file or directory                                  |
| `delete_file`      | Delete one file when deletion is enabled                                   |
| `delete_directory` | Delete an empty or explicitly recursive directory when deletion is enabled |

## Development

```bash
npm install
npm test
npm run format:check
```

## License

[MIT](LICENSE.md)
