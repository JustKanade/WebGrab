# WebGrap

Lightweight batch web resource downloader with auto-scanning capabilities.

## Features

- **Batch Download** - Download multiple URLs simultaneously
- **Auto-Scan** - Automatically extract CSS, JS, images from web pages
- **Real-time Progress** - Live download progress with SSE
- **Smart Organization** - Files organized by domain and page title

## Quick Start

```bash
npm install
npm start
```

The application will automatically open at `http://127.0.0.1:3000/app.html`

## Usage

1. **Manual URLs**: Enter URLs line by line, click "Start Download"
2. **Auto-Scan**: Check "Auto-scan page resources" to extract all page assets
3. **Custom Directory**: Specify target directory (auto-uses page title when scanning)

## Tech Stack

- Node.js + Express
- Server-Sent Events (SSE)
- Vanilla JavaScript
