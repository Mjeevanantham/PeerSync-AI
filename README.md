# PeerSync Dev Connect

A cross-IDE developer collaboration extension for real-time peer communication with AI-powered message validation.

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![Platform](https://img.shields.io/badge/platform-VS%20Code%20%7C%20Cursor%20%7C%20Windsurf-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

## Overview

PeerSync Dev Connect enables frontend and backend developers to:

- **Authenticate** securely with the PeerSync network
- **Discover** available peers in your organization
- **Connect** with team members directly from your IDE
- **Chat** in real-time with AI-powered message validation
- **Insert messages** into IDE AI chat (Copilot, Cursor AI, etc.)
- **Capture AI responses** and send them back to peers automatically

## Features

### Core Features

- 🔐 **Secure Authentication** - JWT-based authentication with automatic token refresh
- 👥 **Peer Discovery** - Find and connect with team members
- 💬 **Real-time Chat** - Message peers directly from your IDE
- 🤖 **AI Validation** - Automatic security scanning and prompt improvement
- 🔗 **IDE AI Integration** - Insert prompts to Copilot/Cursor AI and capture responses

### Security Features

- Input sanitization and validation
- Secrets and PII detection
- Injection attack prevention
- Secure token storage

## Installation

### From VS Code Marketplace

1. Open VS Code/Cursor/Windsurf
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "PeerSync Dev Connect"
4. Click Install

### From VSIX

```bash
code --install-extension peersync-dev-connect-0.1.0.vsix
```

### From Source

```bash
# Clone the repository
git clone https://github.com/peersync/dev-connect.git
cd peer-sync-extension

# Install dependencies
npm install

# Build
npm run compile

# Package
npm run package
```

## Setup

### 1. Build the Extension

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Or watch for changes during development
npm run watch
```

### 2. Configure Settings

Open VS Code settings and configure:

```json
{
  "peerSync.serverUrl": "https://api.peersync.dev",
  "peerSync.autoConnect": false,
  "peerSync.enableAiValidation": true,
  "peerSync.logLevel": "info"
}
```

### 3. Sign In

1. Open the PeerSync sidebar (click the icon in the Activity Bar)
2. Click "Sign In to Get Started"
3. Enter your credentials

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `PeerSync: Connect to Peer` | Connect to the peer network or a specific peer |
| `PeerSync: Open Dashboard` | Open the main dashboard |
| `PeerSync: Open Chat` | Open chat with a peer |
| `PeerSync: Send Message` | Send a message to a connected peer |

Access commands via:
- Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
- PeerSync sidebar buttons
- Keyboard shortcuts (configurable)

### Dashboard

The dashboard shows:
- Your profile and connection status
- List of connected peers
- Recent chat messages
- Quick actions

### Chat

The chat interface supports:
- **Text messages** - Regular text communication
- **Code snippets** - Share code with syntax highlighting
- **AI prompts** - Send prompts for the peer's AI assistant
- **AI responses** - Capture and share AI-generated responses

### AI Integration

1. **Send as AI Prompt**: Mark a message as an AI prompt
2. **Insert to AI**: The recipient can insert the prompt into their IDE AI
3. **Capture Response**: Capture the AI response
4. **Send Back**: Automatically send the response to the original sender

## Development

### Project Structure

```
peer-sync-extension/
├── .vscode/
│   ├── launch.json          # Debug configurations
│   └── tasks.json           # Build tasks
├── src/
│   ├── extension.ts         # Main entry point
│   ├── commands/            # Command handlers
│   │   ├── connectPeer.ts
│   │   ├── openDashboard.ts
│   │   └── sendMessage.ts
│   ├── views/               # WebView providers
│   │   ├── dashboardView.ts
│   │   └── chatView.ts
│   ├── services/            # Core business logic
│   │   ├── authService.ts
│   │   ├── peerService.ts
│   │   ├── aiValidator.ts
│   │   └── messageRouter.ts
│   ├── protocols/           # Communication protocols
│   │   └── peerProtocol.ts
│   ├── models/              # Data models
│   │   └── session.ts
│   └── utils/               # Utilities
│       ├── logger.ts
│       └── constants.ts
├── package.json
├── tsconfig.json
└── README.md
```

### Debug

1. Open the project in VS Code
2. Press F5 to launch the Extension Development Host
3. Set breakpoints in the TypeScript files
4. Use the Debug Console for logging

For Cursor debugging:
1. Use the "Run Extension (Cursor)" configuration

### Build

```bash
# Compile TypeScript
npm run compile

# Watch mode
npm run watch

# Lint
npm run lint

# Fix lint issues
npm run lint:fix
```

### Package

```bash
# Create VSIX package
npm run package
```

This creates `peersync-dev-connect-0.1.0.vsix` in the project root.

### Publish

```bash
# Publish to VS Code Marketplace
npm run publish
```

Requires a Personal Access Token from Azure DevOps.

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `peerSync.serverUrl` | string | `https://api.peersync.dev` | PeerSync server URL |
| `peerSync.autoConnect` | boolean | `false` | Auto-connect on startup |
| `peerSync.enableAiValidation` | boolean | `true` | Enable AI validation |
| `peerSync.logLevel` | string | `info` | Logging level |

## Architecture

### Service Layer

- **AuthService** - Handles authentication, token management, session persistence
- **PeerService** - Manages peer discovery, connections, and real-time communication
- **AiValidatorService** - Provides AI-powered validation, sanitization, and enhancement
- **MessageRouterService** - Routes messages between peers with validation pipeline

### Protocol

The extension uses a versioned protocol for peer communication:

- **Handshake** - Connection establishment with capability negotiation
- **Messages** - Chat, code, AI prompts, and responses
- **Presence** - Online status and typing indicators

### Security

- JWT authentication with automatic refresh
- Secrets and PII detection in messages
- Input sanitization and injection prevention
- Secure storage using VS Code's SecretStorage API

## Roadmap

### Near Term

- [ ] OAuth integration (GitHub, Google, Microsoft)
- [ ] WebRTC / Gateway for P2P connections
- [ ] End-to-end encryption
- [ ] Cursor native API support

### Medium Term

- [ ] File sharing between peers
- [ ] Team rooms for group collaboration
- [ ] Rich text / markdown rendering
- [ ] Code syntax highlighting in chat

### Long Term

- [ ] Analytics dashboard
- [ ] Billing and premium features
- [ ] Enterprise SSO (SAML/OIDC)
- [ ] Mobile companion app (iOS/Android)

## API Reference

### Commands

```typescript
// Connect to peer network or specific peer
vscode.commands.executeCommand('peerSync.connect', peerId?: string);

// Open dashboard
vscode.commands.executeCommand('peerSync.openDashboard');

// Open chat with peer
vscode.commands.executeCommand('peerSync.openChat', peerId: string);

// Send message
vscode.commands.executeCommand('peerSync.sendMessage', peerId: string, content: string, options?: SendMessageOptions);
```

### Events

The extension emits events that can be subscribed to:

```typescript
// Authentication events
authService.onAuthEvent((event, session) => {
  // event: 'login' | 'logout' | 'refresh' | 'expired'
});

// Peer events
peerService.onPeerEvent((event, data) => {
  // event: 'peer_connected' | 'peer_disconnected' | 'peer_discovered' | 'connection_request'
});

// Message events
messageRouter.onMessageEvent((event, message, metadata) => {
  // event: 'message_sent' | 'message_received' | 'message_validated' | 'ai_response_received'
});
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Support

- 📖 [Documentation](https://docs.peersync.dev)
- 🐛 [Issue Tracker](https://github.com/peersync/dev-connect/issues)
- 💬 [Discussions](https://github.com/peersync/dev-connect/discussions)
- 📧 [Email Support](mailto:support@peersync.dev)

---

Built with ❤️ by the PeerSync Team
