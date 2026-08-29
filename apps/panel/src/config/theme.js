// src/lib/theme.js
import { theme as antTheme } from 'antd';
import colors from '@/constants/colors';

const getThemeConfig = (isDark = false, lang = 'fa') => {
  const c = isDark ? colors.dark : colors.light;
  return {
    cssVar: false,
    algorithm: isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
    token: {
      fontSize: 16,
      fontFamily: 'inherit',
      colorPrimary: c.primary,
      colorBgBase: c.bgBase,
      colorBgContainer: c.bgSurface,
      colorTextBase: c.textBase,
      colorTextSecondary: c.textMuted,
      colorError: c.accent,
      colorSuccess:c.success,
      colorBorder: c.border,
    },
    
    components: {
      Message: {
        contentBg: c.bgSurface,
        colorText: c.textBase,
      },
      DatePicker: {
        colorTextDisabled: c.textMuted,
        inputFontSizeLG: 15,
      },
      Input: {
        inputFontSizeLG: 15,
      },
      InputNumber: {
        colorText: c.textBase,
      },
      Upload: {
        colorText: c.textBase,
        fontSize: 18,
        colorTextLabel: c.textBase,
        colorTextDescription: c.textMuted,
      },
      Radio: {
        buttonCheckedBg: 'transparent',
        buttonBg: 'transparent',
        buttonCheckedBgDisabled: 'transparent',
      },
      Table: {
        headerBg: 'transparent',
      },
      Menu: {
        popupBg: c.bgSurface,
        dropdownWidth: '100%',
      },
      Segmented: {
        itemSelectedBg: c.primary,
        itemColor: c.textBase,
        itemSelectedColor: '#fff',
        trackBg: c.bgSurface,
      },
      Timeline: {
        tailColor: c.border,
      },
      Button: {
        borderRadiusLG: 6,
      },
    },
  };
};

export default getThemeConfig;