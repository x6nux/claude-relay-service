package proxy

import (
	"context"
	"claude-middleware/internal/redis"
)

// contextKey is a type for context keys
type contextKey string

const (
	// AccountContextKey is the key for storing account information in context
	AccountContextKey contextKey = "claude_account"
	
	// AccountIDContextKey is the key for storing account ID in context
	AccountIDContextKey contextKey = "claude_account_id"
)

// AccountContext contains account information for request context
type AccountContext struct {
	Account  redis.ClaudeAccount
	ProxyConfig *ProxyConfig
}

// ProxyConfig represents proxy configuration
type ProxyConfig struct {
	Type     string
	Host     string
	Port     int
	Username string
	Password string
}

// WithAccount adds account information to context
func WithAccount(ctx context.Context, account redis.ClaudeAccount) context.Context {
	return context.WithValue(ctx, AccountContextKey, account)
}

// GetAccount retrieves account information from context
func GetAccount(ctx context.Context) (redis.ClaudeAccount, bool) {
	account, ok := ctx.Value(AccountContextKey).(redis.ClaudeAccount)
	return account, ok
}

// WithAccountID adds account ID to context
func WithAccountID(ctx context.Context, accountID string) context.Context {
	return context.WithValue(ctx, AccountIDContextKey, accountID)
}

// GetAccountID retrieves account ID from context
func GetAccountID(ctx context.Context) (string, bool) {
	accountID, ok := ctx.Value(AccountIDContextKey).(string)
	return accountID, ok
}