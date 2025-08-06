package main

import (
	"fmt"
	"log"
	"os"

	"claude-middleware/internal/config"
	"claude-middleware/internal/redis"
)

func main() {
	fmt.Println("Claude Middleware - Metrics Migration Tool")
	fmt.Println("=========================================")

	// 加载配置
	cfg, err := config.LoadConfig("../../config/config.go")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// 连接Redis
	redisClient, err := redis.NewClient(cfg.Redis)
	if err != nil {
		log.Fatalf("Failed to connect to Redis: %v", err)
	}
	defer redisClient.Close()

	if len(os.Args) < 2 {
		printUsage()
		return
	}

	command := os.Args[1]

	switch command {
	case "migrate":
		fmt.Println("\n🚀 Starting metrics migration from ID-based to name-based storage...")
		if err := redisClient.MigrateMetricsFromIDToName(); err != nil {
			log.Fatalf("Migration failed: %v", err)
		}
		fmt.Println("✅ Migration completed successfully!")

	case "cleanup":
		fmt.Println("\n⚠️  WARNING: This will delete all old ID-based metrics!")
		fmt.Print("Are you sure? Type 'yes' to continue: ")
		var confirmation string
		fmt.Scanln(&confirmation)
		if confirmation != "yes" {
			fmt.Println("Operation cancelled.")
			return
		}

		if err := redisClient.CleanupOldMetrics(); err != nil {
			log.Fatalf("Cleanup failed: %v", err)
		}
		fmt.Println("✅ Cleanup completed successfully!")

	case "status":
		fmt.Println("\n📊 Checking metrics storage status...")
		showStatus(redisClient)

	default:
		fmt.Printf("Unknown command: %s\n", command)
		printUsage()
	}
}

func printUsage() {
	fmt.Println("\nUsage:")
	fmt.Println("  go run main.go migrate   - Migrate ID-based metrics to name-based")
	fmt.Println("  go run main.go cleanup   - Remove old ID-based metrics (after migration)")
	fmt.Println("  go run main.go status    - Show current metrics storage status")
	fmt.Println("\nMigration Steps:")
	fmt.Println("  1. Run 'migrate' to convert existing data")
	fmt.Println("  2. Verify the new name-based metrics work correctly")
	fmt.Println("  3. Run 'cleanup' to remove old ID-based data (optional)")
}

func showStatus(client *redis.Client) {
	// 检查ID-based metrics
	fmt.Printf("📋 Checking ID-based metrics...\n")
	idMetrics, err := client.GetAllAccountMetrics()
	if err != nil {
		fmt.Printf("   ❌ Error: %v\n", err)
	} else {
		fmt.Printf("   Found %d ID-based metric entries\n", len(idMetrics))
		for id := range idMetrics {
			fmt.Printf("     - %s\n", id)
		}
	}

	// 检查name-based metrics
	fmt.Printf("\n📋 Checking name-based metrics...\n")
	nameMetrics, err := client.GetAllAccountMetricsByName()
	if err != nil {
		fmt.Printf("   ❌ Error: %v\n", err)
	} else {
		fmt.Printf("   Found %d name-based metric entries\n", len(nameMetrics))
		for name := range nameMetrics {
			fmt.Printf("     - %s\n", name)
		}
	}

	fmt.Printf("\n✨ Status Summary:\n")
	if len(idMetrics) > 0 && len(nameMetrics) == 0 {
		fmt.Printf("   📝 Ready for migration - only ID-based data exists\n")
	} else if len(idMetrics) > 0 && len(nameMetrics) > 0 {
		fmt.Printf("   ⚡ Migration in progress - both formats exist\n")
	} else if len(idMetrics) == 0 && len(nameMetrics) > 0 {
		fmt.Printf("   ✅ Migration complete - using name-based storage\n")
	} else {
		fmt.Printf("   🌟 No metrics data found\n")
	}
}