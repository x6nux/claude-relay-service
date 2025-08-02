# Build the application
build:
	go build -o bin/claude-middleware .

# Run the application
run:
	go run .

# Install dependencies
deps:
	go mod tidy
	go mod download

# Clean build artifacts
clean:
	rm -rf bin/

# Run tests
test:
	go test ./...

# Build for production
build-prod: clean
	CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o bin/claude-middleware .

# Docker build
docker-build:
	docker build -t claude-middleware .

# Docker run
docker-run:
	docker run -p 8080:8080 --env-file .env claude-middleware

.PHONY: build run deps clean test build-prod docker-build docker-run