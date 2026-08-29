import { requireActiveOrg } from '@/lib/auth-service';
import { getDictionary } from '@/lib/dictionary';
import SettingsClient from './_components/SettingsClient';

export async function generateMetadata({ params }) {
    const { lang } = await params;
    const dict = await getDictionary(lang);
    return { title: dict.settings.pageTitle };
}

export default async function Page({ params }) {
    const { lang } = await params;
    await requireActiveOrg(lang);
    return <SettingsClient />;
}