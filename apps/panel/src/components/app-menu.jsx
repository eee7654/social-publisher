// src/components/layout/app-menu.jsx
"use client";

import { Menu } from "antd";
import { useRouter, usePathname } from "next/navigation";
import { useMemo, useEffect } from "react";
import { useAtomValue } from "jotai";
import { abilityAtom } from "@/store/authAtom";
import { SYSTEM_MENUS } from "@/constants/menu";
import { dictAtom, langAtom } from "@/store/i18nAtom";
import Link from "next/link";

const AppMenu = ({ layout = "inline", cliWidth = 360 }) => {
  const router = useRouter();
  const pathname = usePathname();
  const ability = useAtomValue(abilityAtom);
  const dict = useAtomValue(dictAtom);
  const lang = useAtomValue(langAtom);

  const activeKey = useMemo(() => {
    const activeItem = SYSTEM_MENUS.find(item => pathname.includes(item.route));
    return activeItem ? activeItem.key : '1';
  }, [pathname]);

  const finalMenu = useMemo(() => {
    return SYSTEM_MENUS
      .filter(item => {
        if (!item.subject) return true;
        return ability.can(item.action || 'read', item.subject);
      })
      .map((item) => (
        {
          key:item.key,
          label: <Link href={`/${lang}${item.route}`}><span className={layout !== 'inline' ? 'hidden' : 'font-medium'}>{dict.pages?.[item.label]}</span></Link>,
          className: "!flex !items-center !rounded-xl my-1",
          icon: (
            <span className={`!flex !justify-center !text-[20px] !min-w-[20px] ${layout !== "inline" && "!translate-x-[-4px]"}`}>
              {item.icon}
            </span>
          )
        }
      ));
  }, [ability, lang, layout, router]);

  useEffect(() => {
    const el = document.querySelector('.ant-menu-item-selected');
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [activeKey]);

  return (
    <Menu
      selectedKeys={[activeKey]}
      mode={layout}
      items={finalMenu}
      className={`bg-transparent border-none md:w-[94%] ${layout === 'horizontal' ? 'w-full flex-nowrap overflow-x-auto hide-scrollbar' : 'px-3'}`}
      style={
        layout !== 'inline' ? 
          {
            height:60,
            background: "transparent",
            border: "none",
            display: "flex",
            margin: 0,
            justifyContent: "space-between",
            minWidth: finalMenu?.length * 69 < cliWidth ? cliWidth - 24 : finalMenu?.length * 69
          } : {
            background: "transparent",
            border: "none",
            paddingRight: "3%",
            paddingLeft: "3%",
          }
      }
    />
  );
};

export default AppMenu;