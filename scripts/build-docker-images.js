const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dockerDir = path.join(__dirname, '../docker');
const languages = ['javascript', 'python', 'java', 'c', 'cpp', 'php', 'ruby', 'go'];

console.log('Building Docker images for code execution...\n');

// Check if Docker is available
try {
    execSync('docker --version', { stdio: 'ignore' });
} catch (err) {
    console.error('Error: Docker is not installed or not available in PATH');
    console.error('Please install Docker Desktop (Windows/Mac) or Docker (Linux)');
    process.exit(1);
}

// Check if docker directory exists
if (!fs.existsSync(dockerDir)) {
    console.error(`Error: Docker directory not found at ${dockerDir}`);
    process.exit(1);
}

// Build each Docker image
let successCount = 0;
let failCount = 0;

for (const language of languages) {
    const dockerfilePath = path.join(dockerDir, language, 'Dockerfile');
    const imageName = `${language}-compiler:latest`;
    
    if (!fs.existsSync(dockerfilePath)) {
        console.error(`❌ ${language}: Dockerfile not found at ${dockerfilePath}`);
        failCount++;
        continue;
    }
    
    try {
        console.log(`Building ${imageName}...`);
        execSync(`docker build -t ${imageName} ${path.join(dockerDir, language)}`, {
            stdio: 'inherit',
            cwd: path.join(__dirname, '..')
        });
        console.log(`✅ ${imageName} built successfully\n`);
        successCount++;
    } catch (err) {
        console.error(`❌ Failed to build ${imageName}\n`);
        failCount++;
    }
}

console.log('\n========================================');
console.log(`Build Summary: ${successCount} succeeded, ${failCount} failed`);
console.log('========================================\n');

if (failCount > 0) {
    console.error('Some images failed to build. Please check the error messages above.');
    process.exit(1);
}

console.log('All Docker images built successfully!');
console.log('\nYou can verify the images with:');
console.log('  docker images | grep -E "(javascript-compiler|python-compiler|java-compiler|c-compiler|cpp-compiler|php-compiler|ruby-compiler|go-compiler)"');
console.log('\nOr on Windows:');
console.log('  docker images | findstr /i "compiler"');















