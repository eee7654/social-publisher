// src/components/auth/LoginForm.jsx
"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { App, Button, Form, Input, Layout, Flex, Typography, theme, Divider, Modal } from "antd";
import { DotBackground } from "@/components/ui/dot-background";
import "bootstrap-icons/font/bootstrap-icons.css";
import styles from './login.module.css';
import NProgress from 'nprogress';
import Cookies from 'js-cookie';

const { Text, Title } = Typography;

const GoogleIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="20px" height="20px">
    <path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z" />
    <path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z" />
    <path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z" />
    <path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z" />
  </svg>
);

export default function LoginForm({ dict, lang }) {
  const { token } = theme.useToken();
  const router = useRouter();
  const { message } = App.useApp();

  const searchParams = useSearchParams();
  const callbackUrlParam = searchParams.get('callbackURL');
  const safeCallbackUrl = (callbackUrlParam && callbackUrlParam.startsWith('/')) 
    ? callbackUrlParam 
    : `/${lang}/panel/home`;

  const [loading, setLoading] = useState(false);
  
  const [isForgotModalOpen, setIsForgotModalOpen] = useState(false);
  const [forgotStep, setForgotStep] = useState('phone');
  const [resetPhone, setResetPhone] = useState('');

  const dir = lang === 'fa' ? 'rtl' : 'ltr';
  const inputDir = 'ltr'; 

  // ==================== Logic ====================

  const handleGoogleLogin = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: safeCallbackUrl,
    });
  };

  const onLoginFinish = async (values) => {
    setLoading(true);
    const { username, password } = values;
    const { error } = await authClient.signIn.username({ username, password });
    setLoading(false);
    if (error) {
      const errorCode = error.code || error.statusText || "DEFAULT";
      const localizedErrorMessage = 
        dict.auth.errors?.[errorCode] || 
        dict.auth.errors?.DEFAULT || 
        dict.auth.error_login;
      message.error(localizedErrorMessage);
    } else { 
      message.success(dict.auth.welcome);
      NProgress.start()
      router.push(safeCallbackUrl);
    }
  };

  const handleSendResetCode = async (values) => {
    setLoading(true);
    // 🚨 اینجا متد ارسال کدِ بتراث رو صدا می‌زنی
    // مثال: await authClient.forgetPassword.phoneNumber({ phoneNumber: values.phone })
    
    setTimeout(() => { // سیمولیشنِ بک‌اند
      setLoading(false);
      setResetPhone(values.phone);
      setForgotStep('verify');
      message.success(dict.auth.code_sent || "کد ارسال شد");
    }, 1000);
  };

  const handleVerifyAndReset = async (values) => {
    setLoading(true);
    // 🚨 اینجا متد تغییر پسورد با کدِ پیامکی رو صدا می‌زنی
    // مثال: await authClient.resetPassword.phoneNumber({ phoneNumber: resetPhone, code: values.code, newPassword: values.newPassword })
    
    setTimeout(() => {
      setLoading(false);
      setIsForgotModalOpen(false);
      setForgotStep('phone');
      message.success(dict.auth.password_changed || "رمز عبور با موفقیت تغییر کرد");
    }, 1000);
  };
  useEffect(() => {
    Cookies.remove('active_org_id', { path: '/' });
  }, []);
  return (
    <Layout style={{ overflow: 'hidden', width: '100%', height:'100vh', direction: dir }} className='!bg-transparent'>
      <DotBackground alignItems={'center'}>
        <div className="container mx-auto px-4 h-full flex items-center justify-center">
            
            {/* اضافه کردن کلاس‌های bg-bgContainer و border-border برای تطبیق با تم */}
            <div className={`${styles['main-card']} shadow-lg`}>
                
                <img 
                    className={`${styles['brand-img']} animate-pulseScale rounded-2xl`} 
                    src="/app_assets/imgs/logo.jpg" 
                    alt="logo"
                />
                
                {/* حذف !text-white تا انت‌دیزاین خودش بر اساس تم رنگ رو تنظیم کنه */}
                <Title level={5} className="!mb-1 !mt-0 text-center !text-textBase">
                  {dict.auth.title}
                </Title>
                
                <Flex justify={'center'} align={'center'} className='w-full mb-6 mt-1'>
                    {/* استفاده از text-textSecondary به جای رنگ ثابت */}
                    <Text className="text-textSecondary text-xs mx-2">{dict.auth.version_label}</Text>
                    <Text style={{color: token.colorPrimary}} className="text-xs font-bold">0.0.1</Text>
                </Flex>

                <div className="w-full flex-1 mt-3">
                  <Form name="login" layout="vertical" onFinish={onLoginFinish} size="large" className="w-full">
                    <Form.Item name="username" rules={[{ required: true, message: dict.auth.req_username || 'Username is required' }]}>
                      {/* استایل‌های رنگی حذف شد، فقط انحنا (rounded) و ارتفاع ماند */}
                      <Input 
                        prefix={<i className="bi bi-person text-textSecondary mx-1"/>} 
                        placeholder={dict.auth.username_placeholder || 'Username'} 
                        className="rounded-xl h-11" 
                        style={{ direction: inputDir }} 
                      />
                    </Form.Item>
                    
                    <Form.Item name="password" rules={[{ required: true, message: dict.auth.req_pass }]}>
                       <Input.Password 
                         prefix={<i className="bi bi-lock text-textSecondary mx-1"/>} 
                         placeholder={dict.auth.password_placeholder} 
                         className="rounded-xl h-11" 
                         style={{ direction: inputDir }} 
                       />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={loading} className={`${styles['get-started']} w-full h-11 rounded-xl mt-2 font-bold`}>
                      {dict.auth.btn_login}
                    </Button>
                  </Form>
                </div>

                <Divider className="!text-textSecondary text-xs my-5 !border-borderColor">
                  <Flex align="center" justify={'center'} gap="middle">
                    
                    
                    <Button 
                      type="link" 
                      className="text-textSecondary hover:!text-primary !p-0 h-auto text-xs font-medium transition-colors"
                      onClick={() => setIsForgotModalOpen(true)}
                    >
                      {dict.auth.forgot_password}
                    </Button>
                    <span className="text-border opacity-50">|</span>
                    <span>{dict.auth.or_login_with}</span>
                  </Flex>
                </Divider>
                
                <Button 
                    block 
                    size="large" 
                    onClick={handleGoogleLogin} 
                    // استایل دکمه گوگل هم با تم هماهنگ شد
                    className="h-11 rounded-xl flex items-center justify-center gap-2 mb-4 bg-bgBase border-border hover:border-primary text-textBase"
                >
                    <GoogleIcon />
                    <span className="text-sm font-medium">{dict.auth.google_login}</span>
                </Button>

                {/* لینک ثبت‌نام به عنوان یک گزینه جانبی */}
                <div className="text-center mt-2">
                  <Text className="text-textSecondary text-sm">
                    {dict.auth.no_account || "Don't have an account?"}{" "}
                  </Text>
                  <Link href={`/${lang}/register`} className="text-primary hover:text-primaryActive font-medium">
                    {dict.auth.btn_register || "Register"}
                  </Link>
                </div>

            </div>
        </div>
        <Modal
            title={<div className="text-textBase">{dict.auth.forgot_password || "بازیابی رمز عبور"}</div>}
            open={isForgotModalOpen}
            onCancel={() => { setIsForgotModalOpen(false); setForgotStep('phone'); }}
            footer={null}
            centered
            className="custom-auth-modal" // برای استایل‌دهی بک‌گراند مودال با تم
        >
            {forgotStep === 'phone' ? (
                <Form layout="vertical" onFinish={handleSendResetCode} size="large" className="mt-4">
                    <Form.Item name="phone" rules={[{ required: true, pattern: /^(\+98|0)?9\d{9}$/ }]}>
                        <Input prefix={<i className="bi bi-phone text-textSecondary mx-1"/>} placeholder="شماره موبایل" className="rounded-xl h-11" style={{ direction: inputDir }} />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={loading} className={`${styles['get-started']} w-full h-11 rounded-xl`}>
                        ارسال کد تایید
                    </Button>
                </Form>
            ) : (
                <Form layout="vertical" onFinish={handleVerifyAndReset} size="large" className="mt-4">
                    <div className="text-center mb-4 text-sm text-textSecondary">
                        کد ارسال شده به {resetPhone} را وارد کنید
                    </div>
                    <Form.Item name="code" rules={[{ required: true }]}>
                        <Input placeholder="کد تایید ۶ رقمی" className="rounded-xl h-11 text-center tracking-[8px] font-bold" maxLength={6} style={{ direction: inputDir }} />
                    </Form.Item>
                    <Form.Item name="newPassword" rules={[{ required: true, min: 6 }]}>
                        <Input.Password prefix={<i className="bi bi-lock text-textSecondary mx-1"/>} placeholder="رمز عبور جدید" className="rounded-xl h-11" style={{ direction: inputDir }} />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={loading} className={`${styles['get-started']} w-full h-11 rounded-xl`}>
                        تغییر رمز عبور
                    </Button>
                </Form>
            )}
        </Modal>
      </DotBackground>
    </Layout>
  );
}