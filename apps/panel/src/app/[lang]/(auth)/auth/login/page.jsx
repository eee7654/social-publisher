import { getDictionary } from '@/lib/dictionary';
import LoginForm from '@/app/[lang]/(auth)/auth/login/_components/form';

export default async function LoginPage({ params }) {
  const { lang } = await params;
  const dict = await getDictionary(lang);

  return (
    <LoginForm dict={dict} lang={lang} />
  );
}