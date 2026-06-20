import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

type BasePillButtonProps = {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
};

type PillButtonLinkProps = BasePillButtonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
  };

type PillButtonButtonProps = BasePillButtonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    href?: never;
  };

type PillButtonProps = PillButtonLinkProps | PillButtonButtonProps;

export function PillButton({
  children,
  variant = "primary",
  className = "",
  ...props
}: PillButtonProps) {
  const classes = `pill-button pill-button--${variant} ${className}`.trim();

  if ("href" in props && props.href) {
    return (
      <a className={classes} {...props}>
        {children}
      </a>
    );
  }

  const buttonProps = props as PillButtonButtonProps;

  return (
    <button {...buttonProps} className={classes} type={buttonProps.type ?? "button"}>
      {children}
    </button>
  );
}
