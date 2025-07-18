// index.js - Stable Version for Railway

const express = require("express");
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

// --- إعدادات أساسية ---
const requiredEnv = ["TELEGRAM_BOT_TOKEN", "OKX_API_KEY", "OKX_API_SECRET_KEY", "OKX_API_PASSPHRASE", "AUTHORIZED_USER_ID"];
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    console.error(`!!! متغير البيئة ${envVar} غير موجود.`);
  }
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN || "");
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "0", 10);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// --- متغيرات الحالة ---
let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolioState = {};

// --- دوال OKX API ---
function getHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  const bodyString = typeof body === 'object' ? JSON.stringify(body) : body;
  const signString = timestamp + method.toUpperCase() + path + bodyString;
  const signature = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(signString).digest("base64");
  return { "Content-Type": "application/json", "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": signature, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "x-simulated-trading": "0" };
}

async function getMarketPrices() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
    const data = await res.json();
    const prices = {};
    if (data.code === "0" && data.data) {
      data.data.forEach(t => { prices[t.instId] = parseFloat(t.last); });
    }
    return prices;
  } catch (e) { console.error("Error fetching market prices:", e); return {}; }
}

async function getPortfolioData() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, { headers: getHeaders("GET", "/api/v5/account/balance") });
    const data = await res.json();
    if (data.code !== "0") return { assets: null, totalUsd: 0 };
    const prices = await getMarketPrices();
    const portfolio = [];
    data.data[0].details.forEach(asset => {
      const amount = parseFloat(asset.eq);
      if (amount > 0) {
        const instId = `${asset.ccy}-USDT`;
        const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0);
        const usdValue = amount * price;
        if (usdValue >= 1) { // فلترة العملات الصغيرة
            portfolio.push({ asset: asset.ccy, instId, amount, usdValue, price });
        }
      }
    });
    const totalUsd = portfolio.reduce((sum, a) => sum + a.usdValue, 0);
    portfolio.forEach(a => { a.percentage = totalUsd > 0 ? ((a.usdValue / totalUsd) * 100) : 0; });
    portfolio.sort((a, b) => b.usdValue - a.usdValue);
    return { assets: portfolio, totalUsd };
  } catch (e) { console.error("Error fetching portfolio:", e); return { assets: null, totalUsd: 0 }; }
}

// --- Middleware ---
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) return;
  await next();
});

// --- عرض الرصيد المطور ---
async function showBalance(ctx) {
  await ctx.reply("⏳ لحظات... جارٍ تحديث بيانات المحفظة.");
  const { assets, totalUsd } = await getPortfolioData();
  if (!assets) return ctx.reply("❌ حدث خطأ.");

  let msg = `*📊 ملخص المحفظة 📊*\n\n`;
  msg += `*💰 إجمالي القيمة:* *$${totalUsd.toFixed(2)}*\n`;
  msg += `------------------------------------\n`;

  assets.forEach(a => {
    msg += `*💎 ${a.asset}*\n`;
    if (a.asset !== 'USDT') msg += `   *السعر الحالي:* $${a.price.toFixed(4)}\n`;
    msg += `   *القيمة:* $${a.usdValue.toFixed(2)}  *(${a.percentage.toFixed(2)}%)*\n`;
    msg += `   *الكمية:* ${a.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n\n`;
  });
  msg += `_آخر تحديث: ${new Date().toLocaleTimeString("ar-EG", { hour: '2-digit', minute: '2-digit', hour12: true })}_`;
  ctx.reply(msg, { parse_mode: "Markdown" });
}

// --- دوال المراقبة ---
function checkTrades(currentAssets, previousAssets) {
    const notifications = [];
    const prevAssetsMap = new Map(previousAssets.map(a => [a.asset, a]));

    for (const currentAsset of currentAssets) {
        const prevAsset = prevAssetsMap.get(currentAsset.asset);
        if (!prevAsset) {
            if (currentAsset.usdValue >= 1) notifications.push(`*🟢 شراء جديد:* ${currentAsset.amount.toFixed(4)} *${currentAsset.asset}*`);
        } else {
            const amountChange = currentAsset.amount - prevAsset.amount;
            if (Math.abs(amountChange) * currentAsset.price > 1) { 
                const action = amountChange > 0 ? '🔵 شراء إضافي' : '🟠 بيع جزئي';
                notifications.push(`*${action}:* ${Math.abs(amountChange).toFixed(4)} *${currentAsset.asset}*`);
            }
            prevAssetsMap.delete(currentAsset.asset);
        }
    }
    for (const soldAsset of prevAssetsMap.values()) {
        notifications.push(`*🔴 بيع كامل:* ${soldAsset.amount.toFixed(4)} *${soldAsset.asset}*`);
    }
    return notifications.length > 0 ? `*🔄 حركة الصفقات 🔄*\n\n${notifications.join('\n')}` : null;
}

async function startMonitoring(ctx) {
  if (isMonitoring) return ctx.reply("⚠️ المراقبة تعمل بالفعل.");
  isMonitoring = true;
  await ctx.reply("✅ تم تفعيل المراقبة. سأقوم بإعلامك بالصفقات.");
  
  const initialState = await getPortfolioData();
  if (!initialState.assets) {
      isMonitoring = false;
      return ctx.reply("❌ فشلت التهيئة.");
  }
  previousPortfolioState = initialState;

  monitoringInterval = setInterval(async () => {
    const currentPortfolio = await getPortfolioData();
    if (!currentPortfolio.assets) return;

    const tradeNotifications = checkTrades(currentPortfolio.assets, previousPortfolioState.assets);
    if (tradeNotifications) {
        await bot.api.sendMessage(AUTHORIZED_USER_ID, tradeNotifications, { parse_mode: "Markdown" });
    }
    previousPortfolioState = currentPortfolio;
  }, 45000);
}

async function stopMonitoring(ctx) {
  if (!isMonitoring) return ctx.reply("ℹ️ المراقبة متوقفة بالفعل.");
  clearInterval(monitoringInterval);
  isMonitoring = false;
  ctx.reply("🛑 تم إيقاف المراقبة.");
}

// --- الأوامر والـ Callbacks ---
const menu = new InlineKeyboard()
  .text("💰 عرض الرصيد", "show_balance").row()
  .text("👁️ بدء المراقبة", "start_monitoring")
  .text("🛑 إيقاف المراقبة", "stop_monitoring");
  
const welcomeMessage = `*أهلاً بك في بوت مراقبة OKX* 🤖`;

bot.command("start", ctx => ctx.reply(welcomeMessage, { reply_markup: menu, parse_mode: "Markdown" }));
bot.command("balance", showBalance);
bot.command("monitor", startMonitoring);
bot.command("stop", stopMonitoring);

bot.on("callback_query:data", async ctx => {
  const d = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  if (d === "show_balance") await showBalance(ctx);
  if (d === "start_monitoring") await startMonitoring(ctx);
  if (d === "stop_monitoring") await stopMonitoring(ctx);
});

bot.catch((err) => console.error("--- UNCAUGHT ERROR ---", err.error));

// --- التشغيل ---
app.use(webhookCallback(bot, "express"));
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  const domain = process.env.RAILWAY_STATIC_URL;
  if (domain) {
    const webhookUrl = `https://${domain}/${bot.token}`;
    try {
      await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
      console.log(`Webhook successfully set to: ${webhookUrl}`);
    } catch (e) { console.error("!!! Failed to set webhook:", e); }
  } else {
    console.error("!!! RAILWAY_STATIC_URL is not set.");
  }
});