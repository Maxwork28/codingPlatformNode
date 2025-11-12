# Building Docker Images - Quick Guide

## Problem
Error: `No such image: javascript-compiler:latest`

## Solution
Build all Docker images using one of the methods below.

## Method 1: PowerShell (Windows)
```powershell
cd pu/codingPlatformNode
.\build-docker-images.bat
```

**Note:** In PowerShell, you MUST use `.\` prefix to run scripts from the current directory.

## Method 2: npm Script (Recommended - Works Anywhere)
```bash
cd pu/codingPlatformNode
npm run build-docker
```

This works in PowerShell, Git Bash, CMD, and Linux/Mac terminals.

## Method 3: Node.js Script (Works Anywhere)
```bash
cd pu/codingPlatformNode
node scripts/build-docker-images.js
```

## Method 4: Git Bash / Linux / Mac
```bash
cd pu/codingPlatformNode
chmod +x build-docker-images.sh
./build-docker-images.sh
```

## Method 5: Manual Build (If Scripts Don't Work)
Build each image individually:

```bash
cd pu/codingPlatformNode

docker build -t javascript-compiler:latest docker/javascript
docker build -t python-compiler:latest docker/python
docker build -t java-compiler:latest docker/java
docker build -t c-compiler:latest docker/c
docker build -t cpp-compiler:latest docker/cpp
docker build -t php-compiler:latest docker/php
docker build -t ruby-compiler:latest docker/ruby
docker build -t go-compiler:latest docker/go
```

## Prerequisites
- Docker Desktop (Windows/Mac) or Docker (Linux) must be installed and running
- Internet connection (to download base images)

## Verification
After building, verify all images exist:

**PowerShell:**
```powershell
docker images | findstr /i "compiler"
```

**Git Bash / Linux / Mac:**
```bash
docker images | grep compiler
```

You should see 8 images:
- javascript-compiler:latest
- python-compiler:latest
- java-compiler:latest
- c-compiler:latest
- cpp-compiler:latest
- php-compiler:latest
- ruby-compiler:latest
- go-compiler:latest

## Time Required
- First build: 10-30 minutes (downloads base images)
- Subsequent builds: 1-5 minutes (uses cached images)

## After Building
1. Restart your Node.js server (if running)
2. Test the solution in the admin panel

## Troubleshooting

### "Docker is not running"
- Start Docker Desktop (Windows/Mac)
- Check Docker status: `docker --version`

### "Permission denied" (Linux)
```bash
sudo usermod -aG docker $USER
# Log out and log back in
```

### "Build failed"
- Check internet connection
- Check Docker logs
- Verify Dockerfile syntax

### PowerShell: "command not found"
- Use `.\build-docker-images.bat` (with `.\` prefix)
- Or use `npm run build-docker` instead

### Git Bash: "command not found"
- `.bat` files don't work in Git Bash
- Use `npm run build-docker` or `node scripts/build-docker-images.js`

## Quick Reference

| Terminal | Command |
|----------|---------|
| PowerShell | `.\build-docker-images.bat` |
| CMD | `build-docker-images.bat` |
| Git Bash | `npm run build-docker` |
| Linux/Mac | `./build-docker-images.sh` |
| Any | `npm run build-docker` |

