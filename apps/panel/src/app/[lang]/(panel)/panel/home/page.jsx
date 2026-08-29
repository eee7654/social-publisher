// app/[lang]/(panel)/panel/home/page.js
import { getSessionData } from '@/lib/auth-service';
import { redirect } from 'next/navigation';
import OrgSelector from './_components/OrgSelector';
import { getDictionary } from '@/lib/dictionary';

export default async function PanelHome({ params }) {
    const { lang } = await params;
    const sessionData = await getSessionData();
    if (!sessionData) {
      redirect(`/${lang}/auth/login?reason=expired`);
    }
    if (sessionData.memberships === null) {
      redirect(`/${lang}/panel/home/${sessionData.roleName}`);
    }
    if (Array.isArray(sessionData.memberships) && sessionData.memberships.length === 0) {
      const dict = await getDictionary(lang);
      return (
        <div className="flex h-screen items-center justify-center">
          <h2>{dict.home.orgSelector.notJoined}</h2>
        </div>
      );
    }
    return (
      <OrgSelector 
        lang={lang} 
        memberships={sessionData.memberships} 
      />
    );
}