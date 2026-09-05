import localFont from 'next/font/local';
import { Open_Sans } from 'next/font/google';

// فونت فارسی
export const iranSans = localFont({
  src: [
    {
      path: '../fonts/woff2/IRANSansX-Regular.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../fonts/woff2/IRANSansX-Medium.woff2',
      weight: '500',
      style: 'normal',
    },
    {
      path: '../fonts/woff2/IRANSansX-DemiBold.woff2',
      weight: '600',
      style: 'normal',
    },
    {
      path: '../fonts/woff2/IRANSansX-Bold.woff2',
      weight: '700',
      style: 'normal',
    },
  ],
  variable: '--font-iran-sans', // متغیر CSS
  display: 'swap',
});

export const openSans = Open_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '600', '700'], // وزن‌هایی که نیاز دارید
  variable: '--font-open-sans', // متغیر CSS متفاوت
  display: 'swap',
});