# Backpack 自动化递增买入交易系统

这是一个基于Backpack交易所API的自动化交易系统，专注于实现递增买入策略并自动止盈。

## 目录结构

系统采用模块化架构设计，目录结构如下：

```
├── src/                    # 源代码目录
│   ├── config/             # 配置模块
│   │   └── configLoader.js # 配置加载器
│   ├── core/               # 核心业务逻辑
│   │   ├── orderManager.js # 订单管理服务
│   │   ├── priceMonitor.js # 价格监控器
│   │   └── tradingStrategy.js # 交易策略
│   ├── models/             # 数据模型
│   │   ├── Order.js        # 订单模型
│   │   └── TradeStats.js   # 交易统计模型
│   ├── network/            # 网络相关
│   │   └── webSocketManager.js # WebSocket管理器
│   ├── services/           # 服务层
│   │   └── backpackService.js # Backpack API服务
│   ├── utils/              # 工具类
│   │   ├── formatter.js    # 格式化工具
│   │   ├── logger.js       # 日志工具
│   │   └── timeUtils.js    # 时间工具
│   ├── app.js              # 应用程序主类
│   └── index.js            # 程序入口
├── backpack_trading_config.json # 交易配置文件
├── test_create_orders_auto.js   # 原始交易脚本(保留兼容)
├── start_auto_trading.js        # 自动化启动脚本
├── start_modular_trading.js     # 模块化版本启动脚本
└── README.md               # 项目文档
```

## 配置说明

系统通过`backpack_trading_config.json`文件进行配置，主要配置项包括：

### API配置
```json
"api": {
  "privateKey": "YOUR_PRIVATE_KEY",
  "publicKey": "YOUR_PUBLIC_KEY"
}
```

### 交易配置
```json
"trading": {
  "tradingCoin": "SOL",       // 交易币种
  "totalAmount": 500,         // 总投资金额(USDC)
  "orderCount": 10,           // 订单数量
  "maxDropPercentage": 5,     // 最大下跌百分比
  "incrementPercentage": 1.5, // 订单间隔递增百分比
  "takeProfitPercentage": 2   // 止盈百分比
}
```

### 功能开关
```json
"actions": {
  "sellNonUsdcAssets": false,      // 是否卖出非USDC资产
  "cancelAllOrders": true,         // 启动时是否撤销现有订单
  "restartAfterTakeProfit": true,  // 止盈后是否自动重启
  "autoRestartNoFill": true,       // 无订单成交时是否自动重启
  "executeTrade": true,            // 是否执行交易
  "cancelOrdersOnExit": true       // 退出时是否撤销未成交订单
}
```

### 高级配置
```json
"advanced": {
  "checkOrdersIntervalMinutes": 5,   // 检查订单状态间隔(分钟)
  "monitorIntervalSeconds": 15,      // 价格监控间隔(秒)
  "noFillRestartMinutes": 60,        // 无订单成交重启时间(分钟)
  "minOrderAmount": 10,              // 最小订单金额(USDC)
  "priceTickSize": 0.01,             // 价格最小变动单位
  "sellNonUsdcMinValue": 10,         // 非USDC资产最小卖出价值
}
```

### WebSocket配置
```json
"websocket": {
  "url": "wss://ws.backpack.exchange"  // WebSocket端点
}
```

### 精度配置
```json
"minQuantities": {
  "DEFAULT": 0.01,
  "SOL": 0.1,
  "JUP": 1,
  "BTC": 0.00001,
  "ETH": 0.001
},
"quantityPrecisions": {
  "DEFAULT": 2,
  "SOL": 2,
  "JUP": 0,
  "BTC": 5,
  "ETH": 4
},
"pricePrecisions": {
  "DEFAULT": 2,
  "SOL": 2,
  "JUP": 3,
  "BTC": 0,
  "ETH": 2
}
```

## 系统功能

1. **递增买入策略**：基于配置创建多个价格递减的买入订单，随价格下跌增加买入量
2. **实时价格监控**：使用WebSocket连接实时监控市场价格变动
3. **自动止盈**：达到预设止盈点自动卖出获利
4. **统计分析**：实时计算和显示交易统计数据，包括成交量、均价和盈亏情况
5. **失败重试**：订单创建失败时自动重试
6. **安全退出**：优雅处理进程退出，支持自动撤单
7. **自动重启**：无订单成交或止盈后自动重启新一轮交易

## 使用方法

### 安装依赖
```bash
npm install
```

### 配置
编辑`backpack_trading_config.json`文件，设置您的API密钥和交易参数。

### 运行
```bash
# 直接运行模块化版本
node src/index.js

# 或使用模块化版自动启动脚本(带重启功能)
node start_modular_trading.js

# 或使用原有脚本(保持兼容性)
node start_auto_trading.js
```

## 注意事项

1. **API密钥安全**：请确保您的API密钥安全，不要在公共环境中泄露
2. **投资风险**：加密货币交易存在高风险，请根据您的风险承受能力谨慎投资
3. **测试验证**：建议先使用小额资金进行测试，确认系统正常工作后再增加投资金额
4. **监控运行**：系统运行期间建议定期检查，确保一切正常

## 交易策略说明

本系统实现的递增买入策略基于以下原理：

1. 在当前价格以下设置多个买入订单，价格逐步降低
2. 随着价格降低，买入金额逐步增加，形成递增买入
3. 当价格回升至平均买入价以上一定比例时，自动卖出获利

这种策略适合在震荡行情中使用，可以降低平均买入成本，提高盈利机会。

## 开发与贡献

### 模块化设计
系统采用模块化设计，使代码结构清晰、易于维护和扩展：

- **配置模块**：负责加载和验证配置
- **核心模块**：实现交易策略、订单管理和价格监控
- **模型模块**：定义数据模型和状态
- **网络模块**：处理WebSocket通信
- **服务模块**：封装API调用
- **工具模块**：提供通用功能

### 添加新功能
如需添加新功能或支持新的交易策略，建议按以下步骤进行：

1. 在对应模块下创建新的组件
2. 在配置中添加相关参数
3. 在应用层集成新功能
4. 充分测试后再投入使用

## 免责声明

本项目仅供学习和研究使用，作者不对使用本系统进行交易造成的任何损失负责。使用前请充分了解加密货币交易的风险，并自行承担全部责任。

## 许可证

MIT 

## 项目文件说明

以下是项目中所有重要的JavaScript文件及其简要说明：

### 核心代码文件（src目录）

#### 主要入口文件
| 文件 | 大小 | 说明 |
|------|------|------|
| `src/index.js` | 4.4KB | 程序主入口，负责启动应用并处理程序生命周期 |
| `src/app.js` | 27.5KB | 应用程序核心逻辑，协调各组件工作 |

#### 核心功能模块
| 文件 | 大小 | 说明 |
|------|------|------|
| `src/core/orderManager.js` | 12.7KB | 订单管理器，负责订单的创建、取消和跟踪 |
| `src/core/priceMonitor.js` | 8.7KB | 价格监控器，负责实时监控价格变动 |
| `src/core/tradingStrategy.js` | 6.0KB | 交易策略，实现递增买入和止盈策略 |

#### 数据模型
| 文件 | 大小 | 说明 |
|------|------|------|
| `src/models/Order.js` | 5.5KB | 订单模型，定义订单数据结构和操作 |
| `src/models/TradeStats.js` | 4.3KB | 交易统计，跟踪和计算交易统计数据 |

#### 网络服务
| 文件 | 大小 | 说明 |
|------|------|------|
| `src/network/webSocketManager.js` | 12.2KB | WebSocket管理器，处理实时价格数据订阅 |
| `src/services/backpackService.js` | 9.9KB | Backpack交易所API服务，封装API调用 |

#### 工具类
| 文件 | 大小 | 说明 |
|------|------|------|
| `src/utils/logger.js` | 5.7KB | 日志记录工具，处理日志输出和保存 |
| `src/utils/formatter.js` | 5.0KB | 数据格式化工具，处理价格和数量格式 |
| `src/utils/timeUtils.js` | 3.1KB | 时间工具，提供时间相关功能 |

#### 配置管理
| 文件 | 大小 | 说明 |
|------|------|------|
| `src/config/configLoader.js` | 3.5KB | 配置加载器，负责读取和验证配置 |

### 根目录脚本文件

#### 启动脚本
| 文件 | 大小 | 说明 |
|------|------|------|
| `start_modular_trading.js` | 3.6KB | 模块化交易启动脚本，支持自动重启 |
| `start_auto_trading.js` | 1.5KB | 自动交易启动脚本（兼容旧版） |

#### Backpack交易所API相关
| 文件 | 大小 | 说明 |
|------|------|------|
| `backpack_api.js` | 24.9KB | Backpack API包装器，提供API调用功能 |
| `backpack_client.js` | 16.8KB | Backpack客户端，底层API客户端实现 |

#### 测试和工具脚本
| 文件 | 大小 | 说明 |
|------|------|------|
| `test_create_orders_auto.js` | 134.3KB | 自动创建订单测试脚本（完整实现） |
| `test_websocket.js` | 23.1KB | WebSocket测试脚本，测试行情订阅 |
| `test_websocket2.js` | 16.8KB | WebSocket测试脚本2，替代实现 |
| `backpack_price_reader.js` | 9.4KB | 价格读取工具，独立获取价格数据 |
| `btc_order_test.js` | 11.6KB | BTC订单测试，测试BTC交易对订单 |
| `backpack_public_api_test.js` | 13.0KB | 公共API测试，测试行情等公共接口 |
| `backpack_ws_tester.js` | 5.6KB | WebSocket测试器，测试连接和订阅 |
| `test.js` | 0.05KB | 简单测试文件 |

生产环境主要使用src目录下的代码，通过`start_modular_trading.js`或`src/index.js`启动。根目录下的测试脚本主要用于开发和调试过程。 