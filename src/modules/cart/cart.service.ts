import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import { dateValue } from "../geography/shared";

type SelectionInput = { modifierOptionId: string; quantity?: number };
type CatalogSelection = { id: string; name: string; price: number; quantity: number; maxQuantity: number; isDefault: boolean };
type ValidatedProduct = { id: string; name: string; unitPrice: number; selections: CatalogSelection[]; modifiersPrice: number; configurationKey: string };

const quantityOf = (raw: unknown, field = "quantity") => {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > 99)
    throw new AppError(422, "INVALID_CART_QUANTITY", `${field} must be an integer between 1 and 99`);
  return raw;
};

const parseSelections = (raw: unknown): SelectionInput[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new AppError(422, "INVALID_MODIFIER_SELECTION", "Invalid modifier selections");
  const seen = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(422, "INVALID_MODIFIER_SELECTION", "Invalid modifier selection");
    const row = value as Record<string, unknown>;
    if (typeof row.modifierOptionId !== "string" || seen.has(row.modifierOptionId)) throw new AppError(422, "INVALID_MODIFIER_SELECTION", "Invalid or duplicate modifier selection");
    seen.add(row.modifierOptionId);
    return { modifierOptionId: row.modifierOptionId, quantity: quantityOf(row.quantity ?? 1, "modifier quantity") };
  });
};

export class CartService {
  constructor(private client: SQL) {}

  private async lockCustomer(tx: SQL, accountId: string) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`cart:${accountId}`}, 0))`;
    const [customer] = await tx<{ id: string }[]>`select cp.account_id::text id from customer_profiles cp join accounts a on a.id=cp.account_id where cp.account_id=${accountId} and cp.status='ACTIVE' and a.status='ACTIVE'`;
    if (!customer) throw new AppError(401, "AUTHENTICATION_STATE_INVALID", "Authentication state is invalid");
  }

  private async activeCart(tx: SQL, accountId: string, lock = false) {
    const rows = lock
      ? await tx<{ id:string; city_id:string; store_id:string }[]>`select id::text id,city_id::text city_id,store_id::text store_id from carts where customer_account_id=${accountId} and status='ACTIVE' for update`
      : await tx<{ id:string; city_id:string; store_id:string }[]>`select id::text id,city_id::text city_id,store_id::text store_id from carts where customer_account_id=${accountId} and status='ACTIVE'`;
    return rows[0] ?? null;
  }

  private async validateProduct(tx: SQL, cityId: string, storeId: string, productId: string, rawSelections: unknown): Promise<ValidatedProduct> {
    const [store] = await tx<{ order_acceptance_status:string }[]>`select s.order_acceptance_status::text order_acceptance_status from stores s join main_categories mc on mc.id=s.main_category_id and mc.city_id=s.city_id where s.id=${storeId} and s.city_id=${cityId} and s.status='ACTIVE' and s.archived_at is null and mc.status='ACTIVE' and mc.archived_at is null for share of s`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    if (store.order_acceptance_status !== "ACCEPTING") throw new AppError(409, "STORE_NOT_ACCEPTING_ORDERS", "Store is not accepting cart changes");
    const [product] = await tx<{id:string;name:string;base_price:number|null;modifier_group_id:string|null;size_price:number|null}[]>`
      select p.id::text id,p.name,p.base_price,p.modifier_group_id::text modifier_group_id,
        (select ps.price from product_sizes ps where ps.product_id=p.id and ps.status='ACTIVE' and ps.archived_at is null and ps.is_default=true and ps.is_available=true limit 1) size_price
      from products p where p.id=${productId} and p.store_id=${storeId} and p.city_id=${cityId} and p.status='ACTIVE' and p.archived_at is null and p.is_available=true
        and (p.category_id is null or exists(select 1 from store_categories sc where sc.id=p.category_id and sc.store_id=p.store_id and sc.city_id=p.city_id and sc.status='ACTIVE' and sc.archived_at is null))`;
    if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
    const unitPrice = Number(product.base_price ?? product.size_price);
    if (!Number.isSafeInteger(unitPrice) || unitPrice <= 0) throw new AppError(409, "PRODUCT_NOT_ORDERABLE", "Product is not orderable");

    const requested = parseSelections(rawSelections);
    if (!product.modifier_group_id) {
      if (requested.length) throw new AppError(422, "INVALID_MODIFIER_SELECTION", "Product has no modifier group");
      return { id:product.id,name:product.name,unitPrice,selections:[],modifiersPrice:0,configurationKey:"none" };
    }
    const [group] = await tx<{min_select:number;max_select:number}[]>`select min_select,max_select from modifier_groups where id=${product.modifier_group_id} and store_id=${storeId} and city_id=${cityId} and status='ACTIVE' and archived_at is null`;
    if (!group) throw new AppError(409, "PRODUCT_MODIFIERS_INVALID", "Product modifier configuration is invalid");
    const rows = await tx<{id:string;name:string;price:number;is_default:boolean;max_quantity:number;option_available:boolean;configured_available:boolean}[]>`
      select o.id::text id,o.name,pmo.price,pmo.is_default,pmo.max_quantity,o.is_available option_available,pmo.is_available configured_available
      from product_modifier_options pmo join modifier_options o on o.id=pmo.modifier_option_id
      where pmo.product_id=${productId} and pmo.store_id=${storeId} and pmo.city_id=${cityId} and o.modifier_group_id=${product.modifier_group_id} and o.status='ACTIVE' and o.archived_at is null`;
    const byId = new Map(rows.map((r) => [r.id,r]));
    const effective = new Map<string,number>();
    for (const row of rows) if (row.is_default) effective.set(row.id,1);
    for (const selected of requested) effective.set(selected.modifierOptionId, selected.quantity!);
    const selections: CatalogSelection[] = [];
    for (const [id, qty] of effective) {
      const row = byId.get(id);
      if (!row || !row.option_available || !row.configured_available || qty > Number(row.max_quantity)) throw new AppError(422, "INVALID_MODIFIER_SELECTION", "Modifier selection is not selectable");
      selections.push({ id,name:row.name,price:Number(row.price),quantity:qty,maxQuantity:Number(row.max_quantity),isDefault:Boolean(row.is_default) });
    }
    const totalSelected = selections.reduce((sum,s)=>sum+s.quantity,0);
    if (totalSelected < Number(group.min_select) || totalSelected > Number(group.max_select)) throw new AppError(422,"INVALID_MODIFIER_SELECTION","Modifier selection limits are not satisfied");
    selections.sort((a,b)=>a.id.localeCompare(b.id));
    const modifiersPrice = selections.reduce((sum,s)=>sum+s.price*s.quantity,0);
    return { id:product.id,name:product.name,unitPrice,selections,modifiersPrice,configurationKey:selections.map(s=>`${s.id}:${s.quantity}`).join("|") || "none" };
  }

  private async insertOrMerge(tx: SQL, cartId:string, cityId:string, storeId:string, validated:ValidatedProduct, quantity:number) {
    const [item] = await tx<{id:string;quantity:number}[]>`
      insert into cart_items(cart_id,store_id,city_id,product_id,configuration_key,quantity,product_name_snapshot,unit_price_snapshot,modifiers_price_snapshot)
      values(${cartId},${storeId},${cityId},${validated.id},${validated.configurationKey},${quantity},${validated.name},${validated.unitPrice},${validated.modifiersPrice})
      on conflict(cart_id,product_id,configuration_key) do update set quantity=cart_items.quantity+excluded.quantity,unit_price_snapshot=excluded.unit_price_snapshot,modifiers_price_snapshot=excluded.modifiers_price_snapshot,product_name_snapshot=excluded.product_name_snapshot,updated_at=now()
      where cart_items.quantity + excluded.quantity <= 99
      returning id::text id,quantity`;
    if (!item) throw new AppError(422,"INVALID_CART_QUANTITY","Resulting quantity exceeds 99");
    if (item.quantity > 99) throw new AppError(422,"INVALID_CART_QUANTITY","Resulting quantity exceeds 99");
    await tx`delete from cart_item_modifier_selections where cart_item_id=${item.id}`;
    for (const s of validated.selections) await tx`insert into cart_item_modifier_selections(cart_item_id,cart_id,modifier_option_id,quantity,option_name_snapshot,unit_price_snapshot,configuration_snapshot) values(${item.id},${cartId},${s.id},${s.quantity},${s.name},${s.price},${JSON.stringify({maxQuantity:s.maxQuantity,isDefault:s.isDefault})}::jsonb)`;
  }

  async add(accountId:string, cityId:string, storeId:string, input:{productId:string;quantity:number;modifierSelections?:unknown}) {
    const quantity=quantityOf(input.quantity);
    await this.client.begin(async tx=>{
      await this.lockCustomer(tx,accountId);
      const cart=await this.activeCart(tx,accountId,true);
      if (cart && (cart.city_id!==cityId || cart.store_id!==storeId)) throw new AppError(409,cart.city_id!==cityId?"CART_CITY_CONFLICT":"CART_STORE_CONFLICT","Active cart belongs to another store or city");
      const validated=await this.validateProduct(tx,cityId,storeId,input.productId,input.modifierSelections);
      let cartId=cart?.id;
      if (!cartId) { const [created]=await tx<{id:string}[]>`insert into carts(customer_account_id,city_id,store_id) values(${accountId},${cityId},${storeId}) returning id::text id`; if(!created) throw new AppError(500,"INTERNAL_SERVER_ERROR","Cart could not be created"); cartId=created.id; }
      await this.insertOrMerge(tx,cartId!,cityId,storeId,validated,quantity);
      await tx`update carts set updated_at=now() where id=${cartId!}`;
    });
    return this.get(accountId,cityId);
  }

  async replace(accountId:string,cityId:string,storeId:string,input:{productId:string;quantity:number;modifierSelections?:unknown}) {
    const quantity=quantityOf(input.quantity);
    await this.client.begin(async tx=>{
      await this.lockCustomer(tx,accountId);
      const validated=await this.validateProduct(tx,cityId,storeId,input.productId,input.modifierSelections);
      let cart=await this.activeCart(tx,accountId,true);
      if (!cart) { const [created]=await tx<{id:string;city_id:string;store_id:string}[]>`insert into carts(customer_account_id,city_id,store_id) values(${accountId},${cityId},${storeId}) returning id::text id,city_id::text city_id,store_id::text store_id`; cart=created!; }
      await tx`delete from cart_items where cart_id=${cart.id}`;
      await tx`update carts set city_id=${cityId},store_id=${storeId},updated_at=now() where id=${cart.id}`;
      await this.insertOrMerge(tx,cart.id,cityId,storeId,validated,quantity);
    });
    return this.get(accountId,cityId);
  }

  async update(accountId:string,cityId:string,itemId:string,quantityRaw:unknown) {
    const quantity=quantityOf(quantityRaw);
    await this.client.begin(async tx=>{ await this.lockCustomer(tx,accountId); const cart=await this.activeCart(tx,accountId,true); if(!cart||cart.city_id!==cityId) throw new AppError(404,"CART_NOT_FOUND","Cart not found"); await this.assertMutationStore(tx,cart.store_id,cityId); const changed=await tx`update cart_items set quantity=${quantity},updated_at=now() where id=${itemId} and cart_id=${cart.id} returning id`; if(!changed[0]) throw new AppError(404,"CART_ITEM_NOT_FOUND","Cart item not found"); await tx`update carts set updated_at=now() where id=${cart.id}`; }); return this.get(accountId,cityId);
  }
  private async assertMutationStore(tx:SQL,storeId:string,cityId:string) { const [s]=await tx<{status:string;acceptance:string}[]>`select status::text status,order_acceptance_status::text acceptance from stores where id=${storeId} and city_id=${cityId}`; if(!s||s.status!=="ACTIVE") throw new AppError(404,"STORE_NOT_FOUND","Store not found"); if(s.acceptance!=="ACCEPTING") throw new AppError(409,"STORE_NOT_ACCEPTING_ORDERS","Store is not accepting cart changes"); }
  async remove(accountId:string,cityId:string,itemId:string) { await this.client.begin(async tx=>{await this.lockCustomer(tx,accountId);const cart=await this.activeCart(tx,accountId,true);if(!cart||cart.city_id!==cityId)throw new AppError(404,"CART_NOT_FOUND","Cart not found");await this.assertMutationStore(tx,cart.store_id,cityId);const rows=await tx`delete from cart_items where id=${itemId} and cart_id=${cart.id} returning id`;if(!rows[0])throw new AppError(404,"CART_ITEM_NOT_FOUND","Cart item not found");await tx`update carts set updated_at=now() where id=${cart.id}`;});return this.get(accountId,cityId); }
  async clear(accountId:string,cityId:string) { await this.client.begin(async tx=>{await this.lockCustomer(tx,accountId);const cart=await this.activeCart(tx,accountId,true);if(!cart||cart.city_id!==cityId)throw new AppError(404,"CART_NOT_FOUND","Cart not found");await this.assertMutationStore(tx,cart.store_id,cityId);await tx`delete from cart_items where cart_id=${cart.id}`;await tx`update carts set updated_at=now() where id=${cart.id}`;});return this.get(accountId,cityId); }

  async get(accountId:string,cityId:string) {
    const [cart]=await this.client<{id:string;city_id:string;store_id:string;created_at:Date;updated_at:Date;store_name:string;store_status:string;acceptance:string}[]>`select c.id::text id,c.city_id::text city_id,c.store_id::text store_id,c.created_at,c.updated_at,s.name store_name,s.status::text store_status,s.order_acceptance_status::text acceptance from carts c join stores s on s.id=c.store_id and s.city_id=c.city_id where c.customer_account_id=${accountId} and c.status='ACTIVE' and c.city_id=${cityId}`;
    if(!cart)throw new AppError(404,"CART_NOT_FOUND","Cart not found");
    const items=await this.client<any[]>`select ci.*,ci.id::text id,ci.product_id::text product_id,p.name current_name,p.status::text product_status,p.is_available,p.archived_at,p.base_price,
      (select ps.price from product_sizes ps where ps.product_id=p.id and ps.status='ACTIVE' and ps.archived_at is null and ps.is_default=true and ps.is_available=true limit 1) size_price,
      sc.status::text category_status from cart_items ci left join products p on p.id=ci.product_id and p.store_id=ci.store_id and p.city_id=ci.city_id left join store_categories sc on sc.id=p.category_id where ci.cart_id=${cart.id} order by ci.created_at,ci.id`;
    const selections=await this.client<any[]>`select s.*,s.cart_item_id::text cart_item_id,s.modifier_option_id::text modifier_option_id,o.name current_name,o.status::text option_status,o.is_available option_available,o.archived_at,pmo.price current_price,pmo.is_available configured_available,pmo.max_quantity,mg.status::text group_status,mg.min_select,mg.max_select,p.modifier_group_id::text product_group_id,o.modifier_group_id::text option_group_id from cart_item_modifier_selections s left join cart_items ci on ci.id=s.cart_item_id left join products p on p.id=ci.product_id left join modifier_options o on o.id=s.modifier_option_id left join product_modifier_options pmo on pmo.product_id=ci.product_id and pmo.modifier_option_id=s.modifier_option_id left join modifier_groups mg on mg.id=p.modifier_group_id where s.cart_id=${cart.id} order by s.cart_item_id,s.modifier_option_id`;
    const byItem=new Map<string,any[]>();for(const s of selections){const a=byItem.get(s.cart_item_id)??[];a.push(s);byItem.set(s.cart_item_id,a)}
    let itemsSubtotal=0;let cartPriceChanged=false;let allOrderable=cart.store_status==="ACTIVE"&&cart.acceptance==="ACCEPTING";
    const mapped=items.map(row=>{const selected=byItem.get(row.id)??[];const reasons:string[]=[];let valid=row.product_status==="ACTIVE"&&!row.archived_at&&Boolean(row.is_available)&&(row.category_status==null||row.category_status==="ACTIVE")&&cart.store_status==="ACTIVE";if(!valid)reasons.push("PRODUCT_NOT_ORDERABLE");const unit=Number(row.base_price??row.size_price??row.unit_price_snapshot);let modifierPrice=0;const mods=selected.map(s=>{const ok=s.option_status==="ACTIVE"&&!s.archived_at&&s.option_available&&s.configured_available&&s.group_status==="ACTIVE"&&s.product_group_id===s.option_group_id&&Number(s.quantity)<=Number(s.max_quantity);if(!ok){valid=false;reasons.push("MODIFIER_NOT_SELECTABLE")}const price=s.current_price==null?Number(s.unit_price_snapshot):Number(s.current_price);modifierPrice+=price*Number(s.quantity);return{modifierOptionId:s.modifier_option_id,name:s.current_name??s.option_name_snapshot,quantity:Number(s.quantity),currentUnitPrice:price,isValid:ok};});if(selected.length){const total=selected.reduce((n,s)=>n+Number(s.quantity),0);if(total<Number(selected[0].min_select)||total>Number(selected[0].max_select)){valid=false;reasons.push("MODIFIER_LIMITS_CHANGED")}}const priceChanged=unit!==Number(row.unit_price_snapshot)||modifierPrice!==Number(row.modifiers_price_snapshot);const line=(unit+modifierPrice)*Number(row.quantity);itemsSubtotal+=line;cartPriceChanged ||= priceChanged;allOrderable&&=valid;return{id:row.id,product:{id:row.product_id,name:row.current_name??row.product_name_snapshot},quantity:Number(row.quantity),modifierSelections:mods,currentUnitPrice:unit,currentModifiersPrice:modifierPrice,currentLineTotal:line,priceChanged,isAvailable:Boolean(row.is_available),isValid:valid,isOrderable:valid&&cart.acceptance==="ACCEPTING",validationReasons:[...new Set(reasons)]};});
    return{id:cart.id,status:"ACTIVE",cityId:cart.city_id,store:{id:cart.store_id,name:cart.store_name,orderAcceptanceStatus:cart.acceptance},items:mapped,itemsSubtotal,priceChanged:cartPriceChanged,isOrderable:allOrderable&&mapped.length>0,createdAt:dateValue(cart.created_at)!,updatedAt:dateValue(cart.updated_at)!} as any;
  }
}
