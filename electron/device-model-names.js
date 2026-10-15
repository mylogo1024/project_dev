'use strict';

function hw(name, cpu, gpu, cores, ramGb, extra = {}) {
  return {
    name,
    nameZh: extra.nameZh || '',
    cpu,
    gpu,
    cores,
    ramGb,
    coresLabel: extra.coresLabel || `${cores} 核`
  };
}

const A11 = ['A11 Bionic', 'Apple GPU（3-core）', 6, { coresLabel: '6 核（2 性能 + 4 能效）' }];
const A12 = ['A12 Bionic', 'Apple GPU（4-core）', 6, { coresLabel: '6 核（2 性能 + 4 能效）' }];
const A13 = ['A13 Bionic', 'Apple GPU（4-core）', 6, { coresLabel: '6 核（2 性能 + 4 能效）' }];
const A14 = ['A14 Bionic', 'Apple GPU（4-core）', 6, { coresLabel: '6 核（2 性能 + 4 能效）' }];

const IOS_HARDWARE = {
  'iPhone8,1': hw('iPhone 6s', 'A9', 'PowerVR GT7600', 2, 2, { nameZh: '苹果 6s' }),
  'iPhone8,2': hw('iPhone 6s Plus', 'A9', 'PowerVR GT7600', 2, 2, { nameZh: '苹果 6s Plus' }),
  'iPhone8,4': hw('iPhone SE (1st generation)', 'A9', 'PowerVR GT7600', 2, 2, { nameZh: '苹果 SE' }),
  'iPhone9,1': hw('iPhone 7', 'A10 Fusion', 'PowerVR GT7600 Plus', 4, 2, { nameZh: '苹果 7' }),
  'iPhone9,3': hw('iPhone 7', 'A10 Fusion', 'PowerVR GT7600 Plus', 4, 2, { nameZh: '苹果 7' }),
  'iPhone9,2': hw('iPhone 7 Plus', 'A10 Fusion', 'PowerVR GT7600 Plus', 4, 3, { nameZh: '苹果 7 Plus' }),
  'iPhone9,4': hw('iPhone 7 Plus', 'A10 Fusion', 'PowerVR GT7600 Plus', 4, 3, { nameZh: '苹果 7 Plus' }),
  'iPhone10,1': hw('iPhone 8', ...A11.slice(0, 3), 2, { nameZh: '苹果 8', coresLabel: A11[3].coresLabel }),
  'iPhone10,4': hw('iPhone 8', ...A11.slice(0, 3), 2, { nameZh: '苹果 8', coresLabel: A11[3].coresLabel }),
  'iPhone10,2': hw('iPhone 8 Plus', ...A11.slice(0, 3), 3, { nameZh: '苹果 8 Plus', coresLabel: A11[3].coresLabel }),
  'iPhone10,5': hw('iPhone 8 Plus', ...A11.slice(0, 3), 3, { nameZh: '苹果 8 Plus', coresLabel: A11[3].coresLabel }),
  'iPhone10,3': hw('iPhone X', ...A11.slice(0, 3), 3, { nameZh: '苹果 X', coresLabel: A11[3].coresLabel }),
  'iPhone10,6': hw('iPhone X', ...A11.slice(0, 3), 3, { nameZh: '苹果 X', coresLabel: A11[3].coresLabel }),
  'iPhone11,2': hw('iPhone XS', 'A12 Bionic', 'Apple GPU（4-core）', 6, 4, { nameZh: '苹果 XS', coresLabel: A12[3].coresLabel }),
  'iPhone11,4': hw('iPhone XS Max', 'A12 Bionic', 'Apple GPU（4-core）', 6, 4, { nameZh: '苹果 XS Max', coresLabel: A12[3].coresLabel }),
  'iPhone11,6': hw('iPhone XS Max', 'A12 Bionic', 'Apple GPU（4-core）', 6, 4, { nameZh: '苹果 XS Max', coresLabel: A12[3].coresLabel }),
  'iPhone11,8': hw('iPhone XR', 'A12 Bionic', 'Apple GPU（4-core）', 6, 3, { nameZh: '苹果 XR', coresLabel: A12[3].coresLabel }),
  'iPhone12,1': hw('iPhone 11', ...A13.slice(0, 3), 4, { nameZh: '苹果 11', coresLabel: A13[3].coresLabel }),
  'iPhone12,3': hw('iPhone 11 Pro', ...A13.slice(0, 3), 4, { nameZh: '苹果 11 Pro', coresLabel: A13[3].coresLabel }),
  'iPhone12,5': hw('iPhone 11 Pro Max', ...A13.slice(0, 3), 4, { nameZh: '苹果 11 Pro Max', coresLabel: A13[3].coresLabel }),
  'iPhone12,8': hw('iPhone SE (2nd generation)', ...A13.slice(0, 3), 3, { nameZh: '苹果 SE 2', coresLabel: A13[3].coresLabel }),
  'iPhone13,1': hw('iPhone 12 mini', ...A14.slice(0, 3), 4, { nameZh: '苹果 12 mini', coresLabel: A14[3].coresLabel }),
  'iPhone13,2': hw('iPhone 12', ...A14.slice(0, 3), 4, { nameZh: '苹果 12', coresLabel: A14[3].coresLabel }),
  'iPhone13,3': hw('iPhone 12 Pro', 'A14 Bionic', 'Apple GPU（4-core）', 6, 6, { nameZh: '苹果 12 Pro', coresLabel: A14[3].coresLabel }),
  'iPhone13,4': hw('iPhone 12 Pro Max', 'A14 Bionic', 'Apple GPU（4-core）', 6, 6, { nameZh: '苹果 12 Pro Max', coresLabel: A14[3].coresLabel }),
  'iPhone14,2': hw('iPhone 13 Pro', 'A15 Bionic', 'Apple GPU（5-core）', 6, 6, { nameZh: '苹果 13 Pro', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone14,3': hw('iPhone 13 Pro Max', 'A15 Bionic', 'Apple GPU（5-core）', 6, 6, { nameZh: '苹果 13 Pro Max', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone14,4': hw('iPhone 13 mini', 'A15 Bionic', 'Apple GPU（4-core）', 6, 4, { nameZh: '苹果 13 mini', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone14,5': hw('iPhone 13', 'A15 Bionic', 'Apple GPU（4-core）', 6, 4, { nameZh: '苹果 13', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone14,6': hw('iPhone SE (3rd generation)', 'A15 Bionic', 'Apple GPU（4-core）', 6, 4, { nameZh: '苹果 SE 3', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone14,7': hw('iPhone 14', 'A15 Bionic', 'Apple GPU（5-core）', 6, 6, { nameZh: '苹果 14', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone14,8': hw('iPhone 14 Plus', 'A15 Bionic', 'Apple GPU（5-core）', 6, 6, { nameZh: '苹果 14 Plus', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone15,2': hw('iPhone 14 Pro', 'A16 Bionic', 'Apple GPU（5-core）', 6, 6, { nameZh: '苹果 14 Pro', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone15,3': hw('iPhone 14 Pro Max', 'A16 Bionic', 'Apple GPU（5-core）', 6, 6, { nameZh: '苹果 14 Pro Max', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone15,4': hw('iPhone 15', 'A16 Bionic', 'Apple GPU（5-core）', 6, 6, { nameZh: '苹果 15', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone15,5': hw('iPhone 15 Plus', 'A16 Bionic', 'Apple GPU（5-core）', 6, 6, { nameZh: '苹果 15 Plus', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone16,1': hw('iPhone 15 Pro', 'A17 Pro', 'Apple GPU（6-core）', 6, 8, { nameZh: '苹果 15 Pro', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone16,2': hw('iPhone 15 Pro Max', 'A17 Pro', 'Apple GPU（6-core）', 6, 8, { nameZh: '苹果 15 Pro Max', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone17,1': hw('iPhone 16 Pro', 'A18 Pro', 'Apple GPU（6-core）', 6, 8, { nameZh: '苹果 16 Pro', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone17,2': hw('iPhone 16 Pro Max', 'A18 Pro', 'Apple GPU（6-core）', 6, 8, { nameZh: '苹果 16 Pro Max', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone17,3': hw('iPhone 16', 'A18', 'Apple GPU（5-core）', 6, 8, { nameZh: '苹果 16', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone17,4': hw('iPhone 16 Plus', 'A18', 'Apple GPU（5-core）', 6, 8, { nameZh: '苹果 16 Plus', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone17,5': hw('iPhone 16e', 'A18', 'Apple GPU（4-core）', 6, 8, { nameZh: '苹果 16e', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone18,1': hw('iPhone 17 Pro', 'A19 Pro', 'Apple GPU（6-core）', 6, 12, { nameZh: '苹果 17 Pro', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone18,2': hw('iPhone 17 Pro Max', 'A19 Pro', 'Apple GPU（6-core）', 6, 12, { nameZh: '苹果 17 Pro Max', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone18,3': hw('iPhone 17', 'A19', 'Apple GPU（5-core）', 6, 8, { nameZh: '苹果 17', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPhone18,4': hw('iPhone Air', 'A19 Pro', 'Apple GPU（5-core）', 6, 12, { nameZh: '苹果 Air', coresLabel: '6 核（2 性能 + 4 能效）' }),
  'iPad13,18': hw('iPad (10th generation)', 'A14 Bionic', 'Apple GPU（4-core）', 6, 4),
  'iPad13,19': hw('iPad (10th generation)', 'A14 Bionic', 'Apple GPU（4-core）', 6, 4),
  'iPad14,1': hw('iPad mini (6th generation)', 'A15 Bionic', 'Apple GPU（5-core）', 6, 4),
  'iPad14,2': hw('iPad mini (6th generation)', 'A15 Bionic', 'Apple GPU（5-core）', 6, 4)
};

function androidSpec(nameZh, name, cpu, gpu, cores) {
  return { nameZh, name, cpu, gpu, cores };
}

const ANDROID_MODELS = {};

function addAndroid(keys, spec) {
  for (const key of keys) {
    ANDROID_MODELS[String(key).toLowerCase()] = spec;
  }
}

addAndroid(
  ['GM1900', 'GM1901', 'GM1903', 'GM1905', 'OnePlus7', 'guacamole', 'guacamoleb'],
  androidSpec('一加 7', 'OnePlus 7', '骁龙 855', 'Adreno 640', 8)
);
addAndroid(
  ['GM1910', 'GM1911', 'GM1913', 'GM1915', 'GM1917', 'OnePlus7Pro', 'guacamolep'],
  androidSpec('一加 7 Pro', 'OnePlus 7 Pro', '骁龙 855', 'Adreno 640', 8)
);
addAndroid(
  ['GM1920', 'GM1925', 'OnePlus7ProNR'],
  androidSpec('一加 7 Pro 5G', 'OnePlus 7 Pro 5G', '骁龙 855', 'Adreno 640', 8)
);
addAndroid(
  ['HD1900', 'HD1901', 'HD1903', 'HD1905', 'HD1907', 'OnePlus7T', 'hotdogb'],
  androidSpec('一加 7T', 'OnePlus 7T', '骁龙 855+', 'Adreno 640', 8)
);
addAndroid(
  ['HD1910', 'HD1911', 'HD1913', 'HD1925', 'OnePlus7TPro', 'hotdog'],
  androidSpec('一加 7T Pro', 'OnePlus 7T Pro', '骁龙 855+', 'Adreno 640', 8)
);
addAndroid(
  ['ONEPLUS A6000', 'ONEPLUS A6003', 'OnePlus6', 'enchilada'],
  androidSpec('一加 6', 'OnePlus 6', '骁龙 845', 'Adreno 630', 8)
);
addAndroid(
  ['ONEPLUS A6010', 'ONEPLUS A6013', 'OnePlus6T', 'fajita'],
  androidSpec('一加 6T', 'OnePlus 6T', '骁龙 845', 'Adreno 630', 8)
);
addAndroid(
  ['IN2010', 'IN2011', 'IN2013', 'IN2015', 'IN2017', 'OnePlus8', 'instantnoodle'],
  androidSpec('一加 8', 'OnePlus 8', '骁龙 865', 'Adreno 650', 8)
);
addAndroid(
  ['IN2020', 'IN2021', 'IN2023', 'IN2025', 'OnePlus8Pro', 'instantnoodlep'],
  androidSpec('一加 8 Pro', 'OnePlus 8 Pro', '骁龙 865', 'Adreno 650', 8)
);
addAndroid(
  ['KB2000', 'KB2001', 'KB2003', 'KB2005', 'OnePlus8T', 'kebab'],
  androidSpec('一加 8T', 'OnePlus 8T', '骁龙 865', 'Adreno 650', 8)
);
addAndroid(
  ['LE2110', 'LE2111', 'LE2113', 'LE2115', 'LE2117', 'OnePlus9', 'lemonade'],
  androidSpec('一加 9', 'OnePlus 9', '骁龙 888', 'Adreno 660', 8)
);
addAndroid(
  ['LE2120', 'LE2121', 'LE2123', 'LE2125', 'LE2127', 'OnePlus9Pro', 'lemonadep'],
  androidSpec('一加 9 Pro', 'OnePlus 9 Pro', '骁龙 888', 'Adreno 660', 8)
);
addAndroid(
  ['NE2210', 'NE2211', 'NE2213', 'NE2215', 'NE2217', 'OnePlus10Pro', 'OnePlus10Pro5G'],
  androidSpec('一加 10 Pro', 'OnePlus 10 Pro', '骁龙 8 Gen 1', 'Adreno 730', 8)
);
addAndroid(
  ['PHB110', 'CPH2447', 'CPH2449', 'CPH2451', 'OnePlus11', 'OnePlus11 5G'],
  androidSpec('一加 11', 'OnePlus 11', '骁龙 8 Gen 2', 'Adreno 740', 8)
);
addAndroid(
  ['PJD110', 'CPH2573', 'CPH2581', 'CPH2583', 'OnePlus12'],
  androidSpec('一加 12', 'OnePlus 12', '骁龙 8 Gen 3', 'Adreno 750', 8)
);

function iosHardware(productType) {
  return IOS_HARDWARE[String(productType || '').trim()] || null;
}

function formatIosMarketingName(spec, productType) {
  if (!spec) return productType || '';
  if (spec.nameZh && spec.name && spec.nameZh !== spec.name) {
    return `${spec.nameZh}（${spec.name}）`;
  }
  return spec.nameZh || spec.name || productType || '';
}

function isInternalModelCode(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/[\u4e00-\u9fff]/.test(text)) return false;
  if (/\s/.test(text) && /[A-Za-z]/.test(text)) return false;
  if (/^(iPhone|iPad|Pixel|Galaxy|OnePlus|Redmi|Xiaomi|OPPO|vivo|realme|一加|红米|小米)/i.test(text)
    && !/^[A-Z]{2}\d{4}/i.test(text)) return false;
  if (/^(GM|HD|LE|NE|IN|KB|BE|DE|CPH|PJE|PHB|PJD|PJX|RMX|V\d{4}|SM-|A\d{4})\d?/i.test(text)) return true;
  if (/^[A-Z]{2}\d{4}[A-Z0-9]*$/i.test(text)) return true;
  if (/^[a-z]{5,}$/.test(text)) return true;
  return false;
}

function humanizeDeviceCode(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function lookupAndroidModel(...keys) {
  for (const key of keys) {
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) continue;
    if (ANDROID_MODELS[normalized]) return ANDROID_MODELS[normalized];
  }
  return null;
}

function fingerprintCodename(fingerprint) {
  const parts = String(fingerprint || '').split('/');
  return parts[1] || parts[2] || '';
}

function formatAndroidMarketingName(spec, fallback) {
  if (spec) {
    if (spec.nameZh && spec.name && spec.nameZh !== spec.name) {
      return `${spec.nameZh}（${spec.name}）`;
    }
    return spec.nameZh || spec.name || fallback || '';
  }
  return fallback || '';
}

function resolveAndroidIdentity(props = {}) {
  const model = props['ro.product.model'] || props['ro.product.vendor.model'] || '';
  const device = props['ro.product.device'] || props['ro.product.vendor.device'] || '';
  const name = props['ro.product.name'] || '';
  const product = props['ro.build.product'] || fingerprintCodename(props['ro.build.fingerprint']);
  const candidates = [
    props['ro.product.marketname'],
    props['ro.product.odm.marketname'],
    props['ro.vendor.oplus.market.name'],
    props['ro.config.marketing_name'],
    props['ro.oppo.market.name'],
    props['ro.vivo.market.name'],
    props['bluetooth.device.default_name'],
    props['persist.sys.device_name']
  ].map((item) => String(item || '').trim()).filter(Boolean);

  const spec = lookupAndroidModel(model, device, name, product, ...candidates);
  if (spec) {
    return { spec, marketName: formatAndroidMarketingName(spec), model, device, name };
  }

  const friendlyProp = candidates.find((item) => !isInternalModelCode(item));
  if (friendlyProp) {
    if (/oneplus/i.test(friendlyProp) && !/[\u4e00-\u9fff]/.test(friendlyProp)) {
      const nameZh = friendlyProp.replace(/oneplus/ig, '一加').replace(/\s+/g, ' ').trim();
      return {
        spec: null,
        marketName: formatAndroidMarketingName({ nameZh, name: friendlyProp }),
        model,
        device,
        name
      };
    }
    return { spec: null, marketName: friendlyProp, model, device, name };
  }

  const humanDevice = humanizeDeviceCode(device);
  if (humanDevice && humanDevice !== device && !isInternalModelCode(humanDevice)) {
    return { spec: null, marketName: humanDevice, model, device, name };
  }

  return { spec: null, marketName: model || device || name, model, device, name };
}

module.exports = {
  IOS_HARDWARE,
  ANDROID_MODELS,
  iosHardware,
  formatIosMarketingName,
  lookupAndroidModel,
  resolveAndroidIdentity,
  isInternalModelCode,
  humanizeDeviceCode
};
