import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { profileHref } from "@/lib/profile/href";
import { isAdminName } from "@/lib/auth/isAdmin";
import { getCurrentSeason } from "@/utils/getTimes";
import { getLang, setLang, Lang, LANG_EVENT } from "@/lib/i18n/languagePref";
import BottomSheet from "./BottomSheet";

/**
 * Le menu de l'avatar, version tactile. Sur PC il s'ouvre au SURVOL de
 * l'avatar (NavBar, `group-hover`) : un doigt ne survole pas, et ces entrees
 * (Admin, Langue, Creer un compte, Saison, Discord) etaient inatteignables sur
 * telephone. Memes entrees que le menu PC, plus ce que la barre du haut cache
 * faute de place.
 */
type Props = {
  open: boolean;
  onClose: () => void;
  onAuth: (view: "signin" | "signup") => void;
};

const ITEM =
  "flex w-full items-center gap-3 rounded-xl px-4 min-h-[48px] text-left font-karla text-[15px] text-white/90 active:bg-white/10 hover:bg-white/5";

export default function AccountSheet({ open, onClose, onAuth }: Props) {
  const { t } = useTranslation();
  const { data: session }: { data: any } = useSession();
  const [lang, setLangState] = useState<Lang | null>(null);

  useEffect(() => {
    setLangState(getLang());
    const onChange = () => setLangState(getLang());
    window.addEventListener(LANG_EVENT, onChange);
    return () => window.removeEventListener(LANG_EVENT, onChange);
  }, []);

  const year = new Date().getFullYear();
  const season = getCurrentSeason();
  const isAdmin = session && (session.user?.role === "admin" || isAdminName(session.user?.name));

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={session ? session.user?.name || t("nav.profile") : undefined}
    >
      <nav className="grid gap-0.5" onClick={(e) => (e.target as Element).closest("a") && onClose()}>
        {session ? (
          <>
            <Link href={profileHref(session.user)} className={ITEM}>
              {t("nav.profile")}
            </Link>
            {isAdmin && (
              <Link href="/admin" className={ITEM}>
                {t("nav.admin")}
              </Link>
            )}
          </>
        ) : (
          <>
            <button type="button" className={ITEM} onClick={() => { onClose(); onAuth("signin"); }}>
              {t("nav.signIn")}
            </button>
            <button type="button" className={ITEM} onClick={() => { onClose(); onAuth("signup"); }}>
              {t("auth.createAccount")}
            </button>
            <Link href="/en/my-list" className={ITEM}>
              {t("nav.myList")}
            </Link>
          </>
        )}
        <Link href={`/en/search/anime?season=${season.toLowerCase()}&year=${year}`} className={ITEM}>
          {t("nav.season")}
        </Link>
        <Link href="/en/settings" className={ITEM}>
          {t("nav.settings")}
        </Link>
        <a href="https://discord.gg/CbrFwstYfC" target="_blank" rel="noopener noreferrer" className={ITEM}>
          Discord
        </a>

        {lang && (
          <div className="flex items-center justify-between gap-3 px-4 min-h-[56px]">
            <span className="font-karla text-[15px] text-white/90">{t("nav.language")}</span>
            <div className="flex rounded-full bg-white/5 p-1 ring-1 ring-white/10">
              {(["en", "fr"] as Lang[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => l !== lang && setLang(l)}
                  aria-pressed={lang === l}
                  className={`min-w-[52px] h-10 rounded-full uppercase text-sm font-semibold transition-colors ${
                    lang === l ? "bg-action text-white" : "text-white/60"
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}

        {session && (
          <button
            type="button"
            className={`${ITEM} mt-1 border-t border-white/10 rounded-none text-action`}
            onClick={() => signOut({ redirect: true })}
          >
            {t("nav.signOut")}
          </button>
        )}
      </nav>
    </BottomSheet>
  );
}
