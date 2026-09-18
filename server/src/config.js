const req = (k, fallback) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${k}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 10000),
  webOrigin: (process.env.PUBLIC_WEB_ORIGIN || '*').split(',').map((s) => s.trim()),
  jwt: {
    secret: req('JWT_SECRET', 'dev-only-secret-change-me-please-32b'),
    refreshSecret: req('JWT_REFRESH_SECRET', 'dev-only-refresh-change-me-please'),
    accessTtl: '15m',
    refreshTtlDays: 30
  },
  db: {
    url: process.env.DATABASE_URL || '',
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false
  },
  mambu: {
    baseUrl: (process.env.MAMBU_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.MAMBU_API_KEY || '',
    depositProductId: process.env.MAMBU_DEPOSIT_PRODUCT_ID || 'SAVINGS_GHS',
    loanProductId: process.env.MAMBU_LOAN_PRODUCT_ID || 'NANO_LOAN_GHS',
    branchId: process.env.MAMBU_BRANCH_ID || '',
    webhookSecret: process.env.MAMBU_WEBHOOK_SECRET || ''
  },
  momo: {
    baseUrl: process.env.MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com',
    targetEnv: process.env.MOMO_TARGET_ENV || 'sandbox',
    callbackUrl: process.env.MOMO_CALLBACK_URL || '',
    collection: {
      key: process.env.MOMO_COLLECTION_SUBSCRIPTION_KEY || '',
      userId: process.env.MOMO_COLLECTION_USER_ID || '',
      apiKey: process.env.MOMO_COLLECTION_API_KEY || ''
    },
    disbursement: {
      key: process.env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY || '',
      userId: process.env.MOMO_DISBURSEMENT_USER_ID || '',
      apiKey: process.env.MOMO_DISBURSEMENT_API_KEY || ''
    }
  },
  paystack: {
    baseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY || ''
  },
  hubtel: {
    checkoutUrl: (process.env.HUBTEL_CHECKOUT_URL || 'https://payproxyapi.hubtel.com').replace(/\/$/, ''),
    rmpUrl: (process.env.HUBTEL_RMP_URL || 'https://rmp.hubtel.com').replace(/\/$/, ''),
    statusUrl: (process.env.HUBTEL_STATUS_URL || 'https://api-txnstatus.hubtel.com').replace(/\/$/, ''),
    clientId: process.env.HUBTEL_CLIENT_ID || '',
    clientSecret: process.env.HUBTEL_CLIENT_SECRET || '',
    merchantId: process.env.HUBTEL_MERCHANT_ID || '',
    merchantEmail: process.env.HUBTEL_MERCHANT_EMAIL || '',
    callbackUrl: process.env.HUBTEL_CALLBACK_URL || '',
    returnUrl: process.env.HUBTEL_RETURN_URL || '',
    webhookSecret: process.env.HUBTEL_WEBHOOK_SECRET || ''
  },
  ghipss: {
    baseUrl: (process.env.GHIPSS_BASE_URL || '').replace(/\/$/, ''),
    clientId: process.env.GHIPSS_CLIENT_ID || '',
    clientSecret: process.env.GHIPSS_CLIENT_SECRET || '',
    institutionCode: process.env.GHIPSS_INSTITUTION_CODE || '',
    channelCode: process.env.GHIPSS_CHANNEL_CODE || '3',
    webhookSecret: process.env.GHIPSS_WEBHOOK_SECRET || '',
    paths: {
      token: process.env.GHIPSS_PATH_TOKEN || '/oauth/token',
      banks: process.env.GHIPSS_PATH_BANKS || '/gip/banks',
      nameEnquiry: process.env.GHIPSS_PATH_NAME_ENQUIRY || '/gip/name-enquiry',
      transfer: process.env.GHIPSS_PATH_TRANSFER || '/gip/funds-transfer',
      status: process.env.GHIPSS_PATH_STATUS || '/gip/transaction-status'
    }
  },
  kyc: {
    baseUrl: process.env.KYC_BASE_URL || 'https://api.dojah.io',
    appId: process.env.KYC_APP_ID || '',
    secretKey: process.env.KYC_SECRET_KEY || ''
  },
  python: {
    url: (process.env.PYTHON_SERVICE_URL || '').replace(/\/$/, ''),
    token: process.env.PYTHON_SERVICE_TOKEN || ''
  },
  risk: {
    decline: Number(process.env.RISK_DECLINE_THRESHOLD || 85),
    review: Number(process.env.RISK_REVIEW_THRESHOLD || 55)
  }
};

export const isConfigured = {
  mambu: () => Boolean(config.mambu.baseUrl && config.mambu.apiKey),
  momo: () => Boolean(config.momo.collection.key && config.momo.collection.userId),
  paystack: () => Boolean(config.paystack.secretKey),
  hubtel: () => Boolean(config.hubtel.clientId && config.hubtel.clientSecret && config.hubtel.merchantId),
  ghipss: () => Boolean(config.ghipss.baseUrl && config.ghipss.clientId && config.ghipss.institutionCode),
  kyc: () => Boolean(config.kyc.appId && config.kyc.secretKey),
  python: () => Boolean(config.python.url)
};
