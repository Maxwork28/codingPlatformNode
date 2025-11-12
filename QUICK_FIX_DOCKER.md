# Quick Fix: Docker Images Missing Error

## Problem

When testing solutions in the admin panel, you're getting this error:
```
Code execution failed: (HTTP code 404) no such container - No such image: javascript-compiler:latest
```

## Solution

The Docker images for code execution haven't been built yet. You need to build them first.

## Quick Fix (Windows)

1. Open a terminal/command prompt in the `pu/codingPlatformNode` directory
2. Run:
   ```bash
   build-docker-images.bat
   ```
3. Wait for all images to build (this may take several minutes the first time)
4. Verify images are built:
   ```bash
   docker images | findstr /i "compiler"
   ```

## Quick Fix (Linux/Mac)

1. Open a terminal in the `pu/codingPlatformNode` directory
2. Make the script executable:
   ```bash
   chmod +x build-docker-images.sh
   ```
3. Run:
   ```bash
   ./build-docker-images.sh
   ```
4. Wait for all images to build (this may take several minutes the first time)
5. Verify images are built:
   ```bash
   docker images | grep compiler
   ```

## Quick Fix (Using npm)

1. Open a terminal in the `pu/codingPlatformNode` directory
2. Run:
   ```bash
   npm run build-docker
   ```
3. Wait for all images to build

## Manual Build (If Scripts Don't Work)

Build each image manually:

```bash
# JavaScript
docker build -t javascript-compiler:latest docker/javascript

# Python
docker build -t python-compiler:latest docker/python

# Java
docker build -t java-compiler:latest docker/java

# C
docker build -t c-compiler:latest docker/c

# C++
docker build -t cpp-compiler:latest docker/cpp

# PHP
docker build -t php-compiler:latest docker/php

# Ruby
docker build -t ruby-compiler:latest docker/ruby

# Go
docker build -t go-compiler:latest docker/go
```

## Prerequisites

- Docker must be installed and running
- Docker Desktop (Windows/Mac) or Docker daemon (Linux) must be running
- Internet connection (to download base images)

## Verification

After building, verify all images exist:

```bash
# Windows
docker images | findstr /i "javascript-compiler python-compiler java-compiler c-compiler cpp-compiler php-compiler ruby-compiler go-compiler"

# Linux/Mac
docker images | grep -E "(javascript-compiler|python-compiler|java-compiler|c-compiler|cpp-compiler|php-compiler|ruby-compiler|go-compiler)"
```

You should see 8 images listed.

## After Building

Once all images are built, restart your Node.js server:

```bash
npm start
```

Or if using nodemon:
```bash
npm run dev
```

Then try testing a solution again in the admin panel.

## Troubleshooting

### "Docker is not running"
- Start Docker Desktop (Windows/Mac) or start Docker daemon (Linux)
- Verify Docker is running: `docker --version`

### "Permission denied" (Linux)
- Add your user to the docker group:
  ```bash
  sudo usermod -aG docker $USER
  ```
- Log out and log back in
- Or use `sudo` with docker commands

### "Build failed"
- Check your internet connection (Docker needs to download base images)
- Check the Dockerfile for the specific language
- Check Docker logs for detailed error messages

### "No space left on device"
- Clean up Docker images: `docker system prune -a`
- Or remove unused images: `docker image prune -a`

## Need Help?

See `README_DOCKER.md` for more detailed information.

