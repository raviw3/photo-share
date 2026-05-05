# setup-local.ps1
# Run this once after starting Docker Compose
# It creates the S3 bucket and Kafka topics in your local containers

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  PhotoShare Local Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ─────────────────────────────────────────
# Step 1 — Start Docker Compose
# ─────────────────────────────────────────
Write-Host "`n[1/4] Starting Docker containers..." -ForegroundColor Yellow
docker compose up -d

# ─────────────────────────────────────────
# Step 2 — Wait for LocalStack to be ready
# ─────────────────────────────────────────
Write-Host "`n[2/4] Waiting for LocalStack to be ready..." -ForegroundColor Yellow
$maxAttempts = 20
$attempt = 0
do {
    Start-Sleep -Seconds 3
    $attempt++
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:4566/_localstack/health" -ErrorAction Stop
        $s3Status = $response.services.s3
        Write-Host "  Attempt $attempt/$maxAttempts — S3 status: $s3Status"
        if ($s3Status -eq "running") { break }
    } catch {
        Write-Host "  Attempt $attempt/$maxAttempts — LocalStack not ready yet..."
    }
} while ($attempt -lt $maxAttempts)

if ($attempt -eq $maxAttempts) {
    Write-Host "LocalStack did not start in time. Check: docker logs photoshare-localstack" -ForegroundColor Red
    exit 1
}
Write-Host "  LocalStack is ready!" -ForegroundColor Green

# ─────────────────────────────────────────
# Step 3 — Create S3 bucket in LocalStack
# ─────────────────────────────────────────
Write-Host "`n[3/4] Creating S3 bucket in LocalStack..." -ForegroundColor Yellow
aws --endpoint-url=http://localhost:4566 s3 mb s3://photoshare-images-local --region ap-south-1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Bucket 'photoshare-images-local' created!" -ForegroundColor Green
} else {
    Write-Host "  Bucket may already exist — continuing..." -ForegroundColor DarkYellow
}

# ─────────────────────────────────────────
# Step 4 — Create Kafka topics
# ─────────────────────────────────────────
Write-Host "`n[4/4] Waiting for Kafka and creating topics..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

docker exec photoshare-kafka kafka-topics `
    --bootstrap-server localhost:9092 `
    --create --if-not-exists `
    --topic image.uploaded `
    --partitions 1 `
    --replication-factor 1

docker exec photoshare-kafka kafka-topics `
    --bootstrap-server localhost:9092 `
    --create --if-not-exists `
    --topic image.processed `
    --partitions 1 `
    --replication-factor 1

Write-Host "  Kafka topics created!" -ForegroundColor Green

# ─────────────────────────────────────────
# Done
# ─────────────────────────────────────────
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Local environment is ready!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  PostgreSQL : localhost:5432" -ForegroundColor White
Write-Host "  Kafka      : localhost:9092" -ForegroundColor White
Write-Host "  LocalStack : http://localhost:4566" -ForegroundColor White
Write-Host ""
Write-Host "  Run Spring Boot with profile: local" -ForegroundColor White
Write-Host "  (./mvnw spring-boot:run -Dspring-boot.run.profiles=local)" -ForegroundColor DarkGray
Write-Host ""