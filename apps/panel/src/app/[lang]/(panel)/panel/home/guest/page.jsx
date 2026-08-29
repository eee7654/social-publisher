import { requireActiveOrg } from "@/lib/auth-service";
import { getDictionary } from "@/lib/dictionary";
import { redirect } from 'next/navigation';

export default async function GuestHome({ params }) {
  const { lang } = await params;
  const sessionData = await requireActiveOrg(lang)
  if(sessionData.roleName !== 'guest'){
    redirect(`/${lang}/panel/home/${sessionData.roleName}`);
  }
  return (
    <></>
  );
}

export async function generateMetadata({ params }) {
  const { lang } = await params;
  const dict = await getDictionary(lang);
  return {
    title: dict.pages.home,
  };
}