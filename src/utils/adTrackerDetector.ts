/**
 * Ad & Tracker Detector and Stripper.
 */

export interface DetectedTracker {
  id: string;
  name: string;
  category: 'advertising' | 'analytics' | 'tracking';
  riskLevel: 'high' | 'medium' | 'low';
  description: string;
  matchedRules: string[];
}

const KNOWN_TRACKERS = [
  {
    id: 'google-admob',
    name: 'Google AdMob / Ads',
    category: 'advertising' as const,
    riskLevel: 'high' as const,
    description: 'سرویس تبلیغاتی گوگل برای نمایش بنرها و ویدیوهای تبلیغاتی بین‌برنامه‌ای.',
    patterns: [
      'com.google.android.gms.ads',
      'com.google.ads',
      'com.google.android.gms.permission.AD_ID',
      'com.google.android.gms.ads.AdActivity',
    ],
  },
  {
    id: 'unity-ads',
    name: 'Unity Ads',
    category: 'advertising' as const,
    riskLevel: 'high' as const,
    description: 'شبکه تبلیغاتی بازی‌های موتور یونیتی و ردیابی رفتار بازیکن.',
    patterns: ['com.unity3d.ads', 'com.unity3d.services.ads', 'UnityAds'],
  },
  {
    id: 'facebook-ads',
    name: 'Meta / Facebook Audience Network',
    category: 'advertising' as const,
    riskLevel: 'high' as const,
    description: 'ردیابی شناسه کاربر و نمایش تبلیغات هدفمند فیس‌بوک و اینستاگرام.',
    patterns: ['com.facebook.ads', 'AudienceNetworkActivity', 'facebook.ads.AudienceNetworkContentProvider'],
  },
  {
    id: 'applovin',
    name: 'AppLovin MAX / Discovery',
    category: 'advertising' as const,
    riskLevel: 'high' as const,
    description: 'شبکه تبلیغات بین‌برنامه‌ای و جمع‌آوری فراداده‌های دستگاه.',
    patterns: ['com.applovin', 'AppLovinFullscreenActivity', 'applovin.sdk'],
  },
  {
    id: 'ironsource',
    name: 'ironSource / SupersonicAds',
    category: 'advertising' as const,
    riskLevel: 'medium' as const,
    description: 'پلتفرم توزیع و نمایش تبلیغات ویدیویی پاداش‌دار.',
    patterns: ['com.ironsource', 'com.supersonicads', 'InterstitialActivity'],
  },
  {
    id: 'appsflyer',
    name: 'AppsFlyer Analytics',
    category: 'tracking' as const,
    riskLevel: 'high' as const,
    description: 'سرویس اتریبیوشن و ردیابی کانال‌های جذب کاربر و اثر انگشت دستگاه.',
    patterns: ['com.appsflyer', 'AppsFlyerLib', 'com.appsflyer.SingleInstallBroadcastReceiver'],
  },
  {
    id: 'adjust',
    name: 'Adjust Measurement',
    category: 'tracking' as const,
    riskLevel: 'high' as const,
    description: 'ردیابی تعاملات درون‌برنامه‌ای و انتساب کمپین‌های تبلیغاتی.',
    patterns: ['com.adjust.sdk', 'AdjustReferrerReceiver'],
  },
  {
    id: 'firebase-analytics',
    name: 'Google Analytics for Firebase',
    category: 'analytics' as const,
    riskLevel: 'medium' as const,
    description: 'ردیابی رویدادها، ترافیک و رفتار کاربر در صفحه.',
    patterns: ['com.google.android.gms.measurement', 'FirebaseAnalytics', 'AppMeasurementReceiver'],
  },
];

export function detectTrackers(rawXmlText: string, permissions: string[]): DetectedTracker[] {
  const detected: DetectedTracker[] = [];
  const textLower = rawXmlText.toLowerCase();

  for (const tracker of KNOWN_TRACKERS) {
    const matches: string[] = [];
    for (const pattern of tracker.patterns) {
      if (textLower.includes(pattern.toLowerCase())) {
        matches.push(pattern);
      }
    }

    if (tracker.id === 'google-admob' && permissions.includes('com.google.android.gms.permission.AD_ID')) {
      if (!matches.includes('AD_ID')) matches.push('AD_ID (دسترسی شناسه تبلیغاتی)');
    }

    if (matches.length > 0) {
      detected.push({
        ...tracker,
        matchedRules: matches,
      });
    }
  }

  return detected;
}

/**
 * Fully remove ad/tracker components and AD_ID permissions.
 * Clean XML only (no comment placeholders) so Binary AXML re-encode stays valid.
 */
export function stripTrackersFromXml(rawXmlText: string): { cleanedXml: string; removedItemsCount: number } {
  let cleaned = rawXmlText;
  let removedItemsCount = 0;

  const countAndRemove = (re: RegExp) => {
    const matches = cleaned.match(re);
    if (matches && matches.length) {
      removedItemsCount += matches.length;
      cleaned = cleaned.replace(re, '');
    }
  };

  countAndRemove(/\s*<uses-permission[^>]*android:name=["']com\.google\.android\.gms\.permission\.AD_ID["'][^>]*\/>/gi);
  countAndRemove(/\s*<uses-permission[^>]*android:name=["']android\.permission\.ACCESS_ADSERVICES_AD_ID["'][^>]*\/>/gi);
  countAndRemove(/\s*<uses-permission[^>]*android:name=["']android\.permission\.ACCESS_ADSERVICES_ATTRIBUTION["'][^>]*\/>/gi);

  const sdkNeedles = [
    'com\\.google\\.android\\.gms\\.ads',
    'com\\.google\\.ads',
    'com\\.facebook\\.ads',
    'com\\.unity3d\\.(ads|services\\.ads)',
    'com\\.applovin',
    'com\\.ironsource',
    'com\\.supersonicads',
    'com\\.appsflyer',
    'com\\.adjust\\.sdk',
    'com\\.google\\.android\\.gms\\.measurement',
  ];

  for (const needle of sdkNeedles) {
    countAndRemove(new RegExp(`\\s*<(activity|service|receiver|provider)[^>]*${needle}[^>]*/>`, 'gi'));
    countAndRemove(
      new RegExp(`\\s*<(activity|service|receiver|provider)[^>]*${needle}[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi')
    );
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return { cleanedXml: cleaned, removedItemsCount };
}
