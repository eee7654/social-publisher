import { requireActiveOrg } from '@/lib/auth-service';
import { getDictionary } from '@/lib/dictionary';
import OrgansClient from './_components/OrgansClient';

export async function generateMetadata({ params }) {
    const { lang } = await params;
    const dict = await getDictionary(lang);
    return { title: dict.organs.pageTitle };
}

export default async function Page({ params }) {
    const { lang } = await params;
    await requireActiveOrg(lang);
    return <OrgansClient />;
}