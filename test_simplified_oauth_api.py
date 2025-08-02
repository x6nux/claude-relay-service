#!/usr/bin/env python3
"""
测试简化的OAuth账户创建API端点
"""

import requests
import json
import sys

# 配置
API_BASE_URL = "https://ccr.lfree.org/api/v1"
API_KEY = "YOUR_API_KEY_HERE"  # 请替换为您的管理API Key

def create_oauth_account():
    """使用简化的API创建OAuth账户"""
    
    # 账户数据
    account_data = {
        "name": "Test OAuth Account",
        "description": "Created via simplified API",
        "accessToken": "YOUR_ACCESS_TOKEN_HERE",  # 请替换为实际的access token
        "refreshToken": "YOUR_REFRESH_TOKEN_HERE",  # 请替换为实际的refresh token
        "expiresIn": 3600,
        "scopes": "org:create_api_key user:profile user:inference",
        "accountType": "shared",
        "proxy": {
            "type": "socks5",
            "host": "127.0.0.1",
            "port": 1080,
            "username": "proxy_user",
            "password": "proxy_pass"
        }
    }
    
    # 发送请求
    headers = {
        "X-API-Key": API_KEY,
        "Content-Type": "application/json"
    }
    
    url = f"{API_BASE_URL}/accounts/oauth/create"
    
    print(f"🚀 Sending request to: {url}")
    print(f"📦 Request data: {json.dumps(account_data, indent=2)}")
    
    try:
        response = requests.post(url, json=account_data, headers=headers)
        
        print(f"\n📡 Response status: {response.status_code}")
        print(f"📄 Response headers: {dict(response.headers)}")
        
        if response.status_code == 200:
            result = response.json()
            print(f"\n✅ Success! Account created:")
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(f"\n❌ Error: {response.status_code}")
            try:
                error_data = response.json()
                print(json.dumps(error_data, indent=2, ensure_ascii=False))
            except:
                print(response.text)
                
    except requests.exceptions.RequestException as e:
        print(f"\n❌ Request failed: {e}")
        
def test_old_multi_step_flow():
    """测试旧的多步骤OAuth流程（对比用）"""
    
    print("\n" + "="*50)
    print("Testing old multi-step OAuth flow...")
    
    # Step 1: Generate auth URL
    headers = {"X-API-Key": API_KEY, "Content-Type": "application/json"}
    
    response = requests.post(
        f"{API_BASE_URL}/accounts/oauth/generate-url",
        headers=headers,
        json={}
    )
    
    if response.status_code == 200:
        data = response.json()
        print(f"✅ Step 1 - Auth URL generated:")
        print(f"   Session ID: {data['data']['sessionId']}")
        print(f"   Auth URL: {data['data']['authUrl'][:50]}...")
    else:
        print(f"❌ Step 1 failed: {response.status_code}")

if __name__ == "__main__":
    print("🧪 Testing Simplified OAuth Account Creation API")
    print("="*50)
    
    # 检查是否提供了API Key
    if len(sys.argv) > 1:
        API_KEY = sys.argv[1]
        print(f"✅ Using API Key from command line")
    else:
        print("⚠️  No API Key provided. Usage: python test_simplified_oauth_api.py YOUR_API_KEY")
        print("   Using default API Key from script")
    
    # 测试新的简化API
    create_oauth_account()
    
    # 可选：测试旧的流程进行对比
    # test_old_multi_step_flow()