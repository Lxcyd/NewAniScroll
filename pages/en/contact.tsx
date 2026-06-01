import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import { useTranslation } from "react-i18next";

const Contact = () => {
  const { t } = useTranslation();
  return (
    <>
      <Navbar withNav={true} scrollP={5} shrink={true} />
      <div className=" flex h-screen w-screen flex-col items-center justify-center font-karla  font-bold">
        <h1>{t("contact.title")}</h1>
        <p>{t("contact.intro")}</p>
        <p>
          <a href="mailto:contact@aniscroll.com?subject=[AniScroll]%20-%20Your%20Subject">
            contact@aniscroll.com
          </a>
        </p>
      </div>
      <Footer />
    </>
  );
};

export default Contact;
