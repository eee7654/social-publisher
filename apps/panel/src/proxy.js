// src/middleware.js
import { NextResponse } from 'next/server';
import { i18n } from './constants/i18n-config';

export function proxy(request) {
  const { pathname, search } = request.nextUrl;
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.startsWith('/static') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }
  const pathnameIsMissingLocale = i18n.locales.every(
    (locale) => !pathname.startsWith(`/${locale}/`) && pathname !== `/${locale}`
  );
  if (pathnameIsMissingLocale) {
    const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value;
    const locale = (cookieLocale && i18n.locales.includes(cookieLocale))
        ? cookieLocale
        : i18n.defaultLocale;
    return NextResponse.redirect(
      new URL(`/${locale}${pathname === '/' ? '' : pathname}${search}`, request.url)
    );
  }
  const currentLocale = pathname.split('/')[1];
  const isProtectedRoute = pathname.startsWith(`/${currentLocale}/panel`);
  const isAuthRoute = pathname.startsWith(`/${currentLocale}/auth/login`) || pathname.startsWith(`/${currentLocale}/auth/register`);
  const sessionCookie = 
    request.cookies.get('better-auth.session_token') || 
    request.cookies.get('__Secure-better-auth.session_token');
  if (isProtectedRoute && !sessionCookie) {
    const callbackUrl = encodeURIComponent(`${pathname}${search}`);
    return NextResponse.redirect(
      new URL(`/${currentLocale}/auth/login?callbackURL=${callbackUrl}`, request.url)
    );
  }
  if(isAuthRoute){
    const reason = request.nextUrl.searchParams.get('reason');
    if (reason === 'expired') {
      const response = NextResponse.next();
      response.cookies.delete('better-auth.session_token');
      response.cookies.delete('__Secure-better-auth.session_token');
      return response;
    }
  }
  /*if (sessionCookie) {
    return NextResponse.redirect(
      new URL(`/${currentLocale}/panel/home`, request.url)
    );
  }*/
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};