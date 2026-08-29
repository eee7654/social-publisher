import RolesPage from '@/app/[lang]/(panel)/panel/roles/_components/page';
import { apiServer } from '@/lib/api-server';
import { requireActiveOrg } from '@/lib/auth-service';
import { notFound, redirect } from 'next/navigation';
import '@/app/[lang]/(panel)/panel/roles/style.css'
import { getDictionary } from '@/lib/dictionary';

const fetchRoles = async () => {
  try {
    const api = await apiServer();
    const res = await api.get('/api/v1/panel/roles/fetch');
    return { data: res.data, error: null };
  } catch (error) {
    const status = error.response?.status || 500;
    console.error("Roles Fetch Error:", error.customMessage || error.message);
    return { data: null, error: status };
  }
}

export default async function Page({params}) {
  const { lang } = await params;
  await requireActiveOrg(lang);
  const { data: props, error } = await fetchRoles();
  if (error === 403) {
    //redirect(`/${lang}/panel/forbidden`); 
    // یا از تابع بومی نکست برای نمایش صفحه 404 استفاده کنید 
    // (از نظر امنیتی خوبه چون اصلا تایید نمی‌کنه این صفحه وجود داره)
    notFound(); 
  }
  if (error) {
    throw new Error("خطا در دریافت اطلاعات سیستم"); 
  }
  return (
    <RolesPage {...props} />
  )
}

export async function generateMetadata({ params }) {
  const { lang } = await params;
  const dict = await getDictionary(lang);
  return {
    title: dict.pages.roles,
  };
}