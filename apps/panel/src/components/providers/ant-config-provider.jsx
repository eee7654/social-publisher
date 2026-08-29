'use client';

import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { themeAtom } from '@/store/themeAtom';

import { ConfigProvider, App as AntApp } from 'antd';
import getThemeConfig from '@/config/theme'; 
import faIR from 'antd/locale/fa_IR';
import enUS from 'antd/locale/en_US';
import GlobalErrorHandler from './globa-error-handler';

const AntConfigProvider = ({ children, lang, dir }) => {
  const antdLocale = lang === 'fa' ? faIR : enUS;
  const themeMode = useAtomValue(themeAtom);
  const isDark = themeMode === 'dark';
  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [isDark]);
  return (
    <ConfigProvider 
      theme={getThemeConfig(isDark)}
      direction={dir} 
      locale={antdLocale}
    >
      <AntApp className='w-full'>
        <GlobalErrorHandler />
        {children}
      </AntApp>
    </ConfigProvider>
  );
};

export default AntConfigProvider;