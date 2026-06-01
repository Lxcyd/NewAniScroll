import Head from "next/head";
import { motion } from "framer-motion";
import Link from "next/link";
import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import { useTranslation } from "react-i18next";

export default function About() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>AniScroll • Beta</title>
        <meta name="title" content="About" />
        <meta
          name="description"
          content="AniScroll is a platform where you can watch and stream anime or read
              manga for free, without any ads or VPNs. Our mission is to provide
              a convenient and enjoyable experience for anime and manga
              enthusiasts all around the world."
        />
        <meta name="about" content="About this web" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>
      <Navbar withNav={true} scrollP={5} shrink={true} />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="flex flex-col justify-center items-center min-h-screen md:py-0 py-16"
      >
        <div className="max-w-screen-lg w-full px-4 py-10">
          <h1 className="text-4xl font-bold mb-6">{t("about.title")}</h1>
          <p className="text-lg mb-8">{t("about.p1")}</p>
          <p className="text-lg mb-8">{t("about.p2")}</p>
          <p className="text-lg mb-8">{t("about.p3")}</p>
          <p className="text-lg mb-8">{t("about.p4")}</p>
          <Link href="/en/contact">
            <div className="bg-[#ffffff] text-black font-medium py-3 px-6 rounded-lg hover:bg-action transition duration-300 ease-in-out">
              {t("about.contactUs")}
            </div>
          </Link>
        </div>
      </motion.div>
      <Footer />
    </>
  );
}
