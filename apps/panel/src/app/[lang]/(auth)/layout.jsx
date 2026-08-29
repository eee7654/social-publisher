// src/app/[lang]/(panel)/layout.jsx
import { AntdRegistry } from '@ant-design/nextjs-registry';
import AntConfigProvider from '@/components/providers/ant-config-provider';

export default async function PanelLayout({ children, params }) {
  const { lang } = await params;
  const dir = lang === 'fa' ? 'rtl' : 'ltr';
  return (
    <div className="panel-wrapper min-h-screen flex">
      <AntdRegistry>
        <AntConfigProvider lang={lang} dir={dir}>
          <main className="flex-1">
            {children}
          </main>
        </AntConfigProvider>
      </AntdRegistry>
    </div>
  );
}