# Docker Images for Code Execution

This directory contains Dockerfiles for building Docker images used to execute code in various programming languages.

## Prerequisites

- Docker must be installed and running on your system
- Docker daemon must be accessible (Docker Desktop on Windows/Mac, or Docker daemon on Linux)

## Building Docker Images

### Windows

Run the batch script:
```bash
build-docker-images.bat
```

### Linux/Mac

Run the shell script:
```bash
chmod +x build-docker-images.sh
./build-docker-images.sh
```

### Manual Build

You can also build each image manually:

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

## Verifying Images

After building, verify that all images are created:

```bash
docker images | grep -E "(javascript-compiler|python-compiler|java-compiler|c-compiler|cpp-compiler|php-compiler|ruby-compiler|go-compiler)"
```

You should see all 8 images listed.

## Image Names

The images must be named exactly as follows (as specified in `controllers/questionController.js`):

- `javascript-compiler:latest`
- `python-compiler:latest`
- `java-compiler:latest`
- `c-compiler:latest`
- `cpp-compiler:latest`
- `php-compiler:latest`
- `ruby-compiler:latest`
- `go-compiler:latest`

## Troubleshooting

### Error: "No such image: javascript-compiler:latest"

This means the Docker images haven't been built yet. Run the build script to create all images.

### Error: "Cannot connect to Docker daemon"

Make sure Docker Desktop (Windows/Mac) or Docker daemon (Linux) is running.

### Error: "Permission denied"

On Linux, you may need to run Docker commands with `sudo` or add your user to the `docker` group:

```bash
sudo usermod -aG docker $USER
# Then log out and log back in
```

### Error: "Build failed"

Check the Dockerfile for the specific language and ensure all dependencies are correctly specified. Also check your internet connection, as Docker needs to download base images.

## Testing

After building the images, you can test them by running a simple code execution test:

```bash
node test_docker_c.js
```

Or test the solution testing functionality in the admin panel.

## Updating Images

If you modify any Dockerfile, rebuild the corresponding image:

```bash
docker build -t <image-name>:latest docker/<language>
```

For example:
```bash
docker build -t javascript-compiler:latest docker/javascript
```

## Notes

- All images run as non-root user (`appuser`) for security
- Images are configured to run code in `/app` directory
- Memory and CPU limits are set by the Node.js application when creating containers
- Network is disabled (`NetworkMode: 'none'`) for security















