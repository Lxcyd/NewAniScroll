import { useEffect, useState } from "react";

interface CountdownValues {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

interface Props {
  targetDate: number;
  update: Function;
  countdown: CountdownValues;
}

const useCountdown = (targetDate: number, update: Function): Props => {
  const countDownDate = new Date(targetDate).getTime();

  const [countDown, setCountDown] = useState(
    countDownDate - new Date().getTime()
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const newCountDown = countDownDate - new Date().getTime();
      setCountDown(newCountDown);
      if (newCountDown <= 0 && newCountDown > -1000) {
        update();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [countDownDate, update]);

  return {
    targetDate,
    update,
    countdown: getReturnValues(countDown),
  };
};

const getReturnValues = (rawCountDown: number): CountdownValues => {
  // Once the target time has passed the raw value goes negative, which made
  // Math.floor emit negative days/hours/minutes/seconds (e.g. "-1 / -3 / -34").
  // Clamp to 0 so we show 0/0/0/0 until update() swaps in the next airing.
  const countDown = Math.max(0, rawCountDown);
  // calculate time left
  const days = Math.floor(countDown / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (countDown % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
  );
  const minutes = Math.floor((countDown % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((countDown % (1000 * 60)) / 1000);

  return { days, hours, minutes, seconds };
};

export { useCountdown };
