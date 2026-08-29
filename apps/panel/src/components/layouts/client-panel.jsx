// src/components/layout/client-panel-layout.jsx
"use client";

import { useEffect, useState } from 'react';
import { Layout, Space, Divider, Flex, Image, Typography, Tooltip, Affix, Card } from 'antd';
import AppMenu from '@/components/app-menu';
import { DotBackground } from '@/components/ui/dot-background';

import { useAtomValue } from 'jotai';
import { userAtom } from '@/store/authAtom';
import { dictAtom, dirAtom } from '@/store/i18nAtom';

const { Header, Sider } = Layout;
const { Text, Paragraph } = Typography;

const iconStyles = {
  fontSize: '24px',
  verticalAlign: 'middle',
  cursor: 'pointer',
};


export default function ClientPanel({ children }) {
  const [collapsed, setCollapsed] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [cliWidth, setCliWidth] = useState(360);

  const user = useAtomValue(userAtom);
  const dict = useAtomValue(dictAtom);
  const dir = useAtomValue(dirAtom);

  const toggleCollapsed = () => setCollapsed(!collapsed);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 640);
      setCliWidth(window.innerWidth);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <Layout className='!w-full !h-screen !overflow-hidden bg-bgBase'>
      {!isMobile && (
        <Sider
          trigger={null}
          collapsible
          collapsed={collapsed}
          width={240}
          collapsedWidth={80}
          className='!bg-bgSurface !border-e border-borderColor'
          breakpoint="lg"
        >
          <Header style={{ background: 'transparent', width: '100%', padding: '0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Flex justify={collapsed ? 'center' : 'start'} align='center' className='w-full'>
              <Image 
                className={`${!collapsed ? 'ms-[26px]' : 'ms-[13px]'} rounded-2xl`} 
                width={40} 
                height={40} 
                src={'/app_assets/imgs/logo.jpg'} 
                preview={false}
                alt="logo"
              />
              
              <Flex vertical justify={'center'} align={'start'} className={`${collapsed ? '!hidden' : '!ms-[40px]'}`}>
                <Text className='my-0 text-textBase font-bold'>
                  {dict.common?.app_name}
                </Text>
                <Tooltip title={user?.name} placement='bottom'>
                  <Paragraph ellipsis={{ rows: 1, expandable: false }} className="text-textSecondary !mb-0 !max-w-[138px]" style={{ fontWeight: '400', fontSize: 13 }}>
                    {user?.name}
                  </Paragraph>
                </Tooltip>
              </Flex>
            </Flex>
            <Space 
              className={`!bg-transparent grid ${dir === 'rtl' ? 'translate-x-[-13px]' : 'translate-x-[13px]'}`} 
              onClick={toggleCollapsed} 
              style={{ marginBottom: 0, zIndex: 999 }} 
              size={32}
            >
              {collapsed ? (
                <i style={{...iconStyles,rotate:dir === 'rtl' ? 'unset' : '180deg'}} className='bi bi-arrow-left-circle hidden md:grid text-border hover:text-primary transition-colors bg-bgBase rounded-full' />
              ) : (
                <i style={{...iconStyles,rotate:dir === 'rtl' ? 'unset' : '180deg'}} className='bi bi-arrow-right-circle hidden md:grid text-border hover:text-primary transition-colors bg-bgBase rounded-full' />
              )}
            </Space>
          </Header>
          <Divider plain className="!border-borderColor !mt-0 !mb-2 !min-w-[92%] !w-[92%] !mx-auto" />
          <AppMenu layout="inline" />
          <div className={`absolute bottom-4 w-full ${collapsed ? 'px-2' : 'px-4'}`}>
            <Card className='!bg-bgBase border-none shadow-sm' classNames={{body:'!p-[12px]'}}>
                <Flex justify='space-around' align='center'>
                    {!collapsed && (<Text className='text-gray-500 text-xs'>{dict.auth.version_label}</Text>)}
                    <Text className='text-[#2e424d] text-xs' strong>1.0.0</Text>
                </Flex>
            </Card>
          </div>
        </Sider>
      )}
      <Layout className="min-[375px]:min-h-[100vh-76px] min-[640px]:min-h-screen bg-transparent overflow-y-auto">
        <DotBackground>
          {children}
        </DotBackground>
      </Layout>
      {isMobile && (
        <Affix offsetBottom={0}>
          <Flex align={'center'} className='bg-bgSurface border-t border-border w-full rounded-t-[16px] h-[76px] px-3 shadow-[0_-4px_10px_rgba(0,0,0,0.05)]'>
            <Flex align={'center'} className='overflow-x-auto w-full h-full hide-scrollbar'>
              <AppMenu layout='horizontal' cliWidth={cliWidth} />
            </Flex>
          </Flex>
        </Affix>
      )}
    </Layout>
  );
}