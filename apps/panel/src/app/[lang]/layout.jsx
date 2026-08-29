import "@/app/globals.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import NextTopLoader from 'nextjs-toploader';
import { i18n } from '@/constants/i18n-config';
import { iranSans, openSans } from "@/config/fonts";
import { getDictionary } from '@/lib/dictionary';
import ReactQueryProvider from "@/components/providers/react-query-provider";

export default async function RootLayout({ children, params }) {
  const { lang } = await params;
  const dir = lang === 'fa' ? 'rtl' : 'ltr';
  const fontTailwindClass = lang === 'fa' ? 'font-iransans' : 'font-opensans'
  const fontVariable = lang === 'fa' ? iranSans.variable : openSans.variable;
  return (
    <html lang={lang} dir={dir} className={`${fontVariable}`} suppressHydrationWarning>
      <body className={`${fontTailwindClass} min-h-screen bg-bgBase text-textBase antialiased transition-colors duration-300`} >
        <NextTopLoader color="var(--color-primary-active)" showSpinner={false} />
        <ReactQueryProvider>
          {children}
        </ReactQueryProvider>
      </body>
    </html>
  );
}

export async function generateStaticParams() {
  return i18n.locales.map((locale) => ({ lang: locale }));
}

export async function generateMetadata({ params }) {
  const { lang } = await params;
  const dict = await getDictionary(lang);
  const appName = dict.common.app_name || 'App Name';
  return {
    title: {
      template: `%s | ${appName}`,
      default: appName, 
    },
    description: "",
  };
}