// src/lib/auth-service.js
import { cache } from 'react';
import { apiServer } from '@/lib/api-server';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export const getSessionData = cache(async () => {
  try {
    const api = await apiServer();
    const res = await api.get('/api/v1/panel/session');
    return res.data;
  } catch (error) {
    if (error.response?.status === 401) {
      return null; 
    }
    console.error("CASL Fetch Error:", error.customMessage);
    return { rules: [], user: null, roleName: null };
  }
});


export const requireActiveOrg = async (lang) => {
  const sessionData = await getSessionData();
  if (!sessionData || !sessionData.user) {
    redirect(`/${lang}/auth/login?reason=expired`);
  }
  if (Array.isArray(sessionData.memberships)) {
    if (sessionData.memberships.length === 0) {
      redirect(`/${lang}/panel/home`);
    }
    const cookieStore = await cookies();
    const activeOrgId = cookieStore.get('active_org_id')?.value;
    if (!activeOrgId) {
      redirect(`/${lang}/panel/home`);
    }
    const isValidOrg = sessionData.memberships.some(m => String(m.org_id) === String(activeOrgId));
    if (!isValidOrg) {
      redirect(`/${lang}/panel/home`);
    }
  }
  return sessionData;
};